import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { saveDeck } from '../src/main/deckStore.js';
import { startCollabServer, type RunningCollabServer } from '../src/server/collabServer.js';
import { emptyDeck, type Deck } from '../src/shared/deck.js';
import {
  Cdp,
  electronBinary,
  eventually,
  findTarget,
  launchBrowser,
  stopBrowser,
  wait,
  type RunningBrowser,
} from './support/browserSession.js';
import { collabClientDir } from './support/collabClient.js';
import {
  enterEditing,
  markupProblems,
  persistedMarkupProblems,
} from './support/pasteMarkupCorpus.js';

/**
 * Cmd/Ctrl+K in a text box opens the link dialog (textLinkDialog.ts): it links
 * the selected words, changes the address of the link the caret is in, removes
 * it, or on a bare caret inserts the address as a link. Each is one undo step.
 *
 * The chord, the typing into the dialog and Return are real keyboard input,
 * and the text edit stays open underneath the dialog throughout. Both the
 * live box and the markup the collaboration server stored are checked.
 */
const DECK_ID = 'text-link-shortcut';
const TEXT_ID = 'text-link-shortcut-text';
const CONTENT = `#canvas [data-element-id="${TEXT_ID}"] .text-content`;
const MOD = process.platform === 'darwin' ? 4 : 2;

let workDir = '';
let server: RunningCollabServer | null = null;
let browser: RunningBrowser | null = null;
let editor: Cdp | null = null;

afterEach(async () => {
  editor?.close();
  editor = null;
  await stopBrowser(browser?.process ?? null);
  browser = null;
  await server?.close();
  server = null;
  if (workDir) await rm(workDir, { recursive: true, force: true });
  workDir = '';
});

/** The fixture deck, served by a real collaboration server. */
async function open(html: string): Promise<Cdp> {
  workDir = await mkdtemp(join(tmpdir(), 'text-link-shortcut-'));
  const decksRoot = join(workDir, 'decks');
  const deckDir = join(decksRoot, DECK_ID);
  const clientDir = await collabClientDir();
  const profileDir = join(workDir, 'electron-profile');
  await mkdir(deckDir, { recursive: true });
  await mkdir(profileDir, { recursive: true });

  const deck = emptyDeck('Text link shortcut');
  deck.themePreset = 'basic';
  deck.slides[0].elements.push({
    id: TEXT_ID, type: 'text', x: 120, y: 160, w: 1680, h: 600,
    rot: 0, z: 1, opacity: 1, class: ['role-body'], style: {},
    html, align: 'left', valign: 'top',
  } as never);
  await saveDeck(deckDir, deck);
  await writeFile(join(deckDir, 'theme.css'), [
    '.slide { background: #fff; color: #111827; }',
    '.role-body { font: 400 36px/1.3 sans-serif; }',
    '',
  ].join('\n'), 'utf8');

  server = await startCollabServer({
    rootDir: decksRoot, clientDir, host: '127.0.0.1', port: 0,
  });
  browser = await launchBrowser(
    `http://127.0.0.1:${server.port}/?deck=${DECK_ID}&name=Text%20Links`, profileDir,
  );
  const target = await findTarget(
    browser.debugPort,
    (candidate) => candidate.url.includes(`deck=${DECK_ID}`),
    browser.log,
  );
  editor = await Cdp.connect(target.webSocketDebuggerUrl!);
  await eventually(async () => editor!.evaluate<boolean>(
    `Boolean(document.querySelector('${CONTENT}'))`), 'the link fixture never loaded');
  return editor;
}

/** What the collaboration server has stored for the box. */
async function committedHtml(): Promise<string> {
  const response = await fetch(`http://127.0.0.1:${server!.port}/api/deck?deck=${DECK_ID}`);
  const live = await response.json() as Deck;
  const element = live.slides[0].elements.find((candidate) => candidate.id === TEXT_ID);
  return element && element.type === 'text' ? element.html : '';
}

/** Every link in the live box, as href plus the words it covers. */
async function liveLinks(cdp: Cdp): Promise<Array<{ href: string; text: string }>> {
  return cdp.evaluate(`[...document.querySelectorAll('${CONTENT} a')].map((node) => ({
    href: node.getAttribute('href'),
    text: node.textContent.replaceAll('⁠', ''),
  }))`);
}

const text = async (cdp: Cdp): Promise<string> => (await cdp.evaluate<string>(
  `document.querySelector('${CONTENT}')?.textContent ?? ''`))
  .replaceAll('⁠', '')
  .replaceAll(' ', ' ');

/** Nothing structurally wrong, on screen and in what was stored. */
async function expectSoundMarkup(cdp: Cdp, label: string): Promise<void> {
  expect(await markupProblems(cdp, CONTENT), `${label}: live markup`).toEqual([]);
  expect(
    await persistedMarkupProblems(cdp, await committedHtml()),
    `${label}: stored markup`,
  ).toEqual([]);
}


const DIALOG = '.text-link-dialog';
const INPUT = `${DIALOG} input`;

async function openLinkDialog(cdp: Cdp): Promise<void> {
  await cdp.chord('k', 'KeyK', 75, MOD);
  await eventually(async () => cdp.evaluate<boolean>(
    `document.activeElement === document.querySelector('${INPUT}')`),
  'Cmd/Ctrl+K did not open the link dialog with its field focused');
}

/** Whether the box is still being edited, with the keyboard in it. */
const stillEditing = async (cdp: Cdp): Promise<boolean> => cdp.evaluate<boolean>(
  `document.activeElement === document.querySelector('${CONTENT}')`);

describe.skipIf(!electronBinary)('Cmd/Ctrl+K links text', () => {
  it('links the selected words, edits the link, removes it, one undo step each', {
    timeout: 150_000,
  }, async () => {
    const cdp = await open('<p>Read our paper today</p>');
    await enterEditing(cdp, CONTENT);
    await cdp.selectTextRange(CONTENT, 'Read our '.length, 'Read our paper'.length, 'the word');

    // Link: a bare domain is accepted and becomes https.
    await openLinkDialog(cdp);
    await cdp.typeKeys('arxiv.org/abs/2301.00001');
    await cdp.key('Enter', 13);
    await eventually(async () => liveLinks(cdp), 'the selected word was not linked',
      (links) => links.length === 1);
    expect(await liveLinks(cdp)).toEqual([{ href: 'https://arxiv.org/abs/2301.00001', text: 'paper' }]);
    expect(await text(cdp), 'linking changed no characters').toBe('Read our paper today');
    expect(await cdp.evaluate<boolean>(`!document.querySelector('${DIALOG}')`), 'the dialog closed').toBe(true);
    expect(await stillEditing(cdp), 'the text edit survived the dialog').toBe(true);
    await eventually(committedHtml, 'the link never reached the server',
      (html) => html.includes('<a href="https://arxiv.org/abs/2301.00001">paper</a>'));

    // Edit: Cmd/Ctrl+K inside the link shows its address and replaces it.
    await openLinkDialog(cdp);
    expect(await cdp.evaluate<string>(`document.querySelector('${INPUT}').value`))
      .toBe('https://arxiv.org/abs/2301.00001');
    await cdp.typeKeys('https://example.com/v2');
    await cdp.key('Enter', 13);
    await eventually(async () => liveLinks(cdp), 'the link was not retargeted',
      (links) => links[0]?.href === 'https://example.com/v2');
    expect(await liveLinks(cdp)).toEqual([{ href: 'https://example.com/v2', text: 'paper' }]);

    // Remove: the dialog's Remove link turns it back into plain words.
    await openLinkDialog(cdp);
    await cdp.clickByText(`${DIALOG} button`, 'Remove link');
    await eventually(async () => liveLinks(cdp), 'the link was not removed',
      (links) => links.length === 0);
    expect(await text(cdp)).toBe('Read our paper today');
    expect(await stillEditing(cdp), 'the text edit survived removing the link').toBe(true);

    // One Ctrl/Cmd+Z per step: the removal, then the edit, then the link.
    await cdp.chord('z', 'KeyZ', 90, MOD);
    await eventually(async () => liveLinks(cdp), 'undo did not bring the link back',
      (links) => links[0]?.href === 'https://example.com/v2');
    await cdp.chord('z', 'KeyZ', 90, MOD);
    await eventually(async () => liveLinks(cdp), 'undo did not restore the first address',
      (links) => links[0]?.href === 'https://arxiv.org/abs/2301.00001');
    await cdp.chord('z', 'KeyZ', 90, MOD);
    await eventually(async () => liveLinks(cdp), 'undo did not take back the link',
      (links) => links.length === 0);
    expect(await text(cdp)).toBe('Read our paper today');
    await expectSoundMarkup(cdp, 'after linking, editing, removing and undoing');
  });

  it('inserts the address as a link at a bare caret, and Escape changes nothing', {
    timeout: 120_000,
  }, async () => {
    const cdp = await open('<p>Code:</p>');
    await enterEditing(cdp, CONTENT);
    await cdp.key('End', 35);
    await cdp.typeKeys(' ');

    await openLinkDialog(cdp);
    await cdp.key('Escape', 27);
    await eventually(async () => cdp.evaluate<boolean>(`!document.querySelector('${DIALOG}')`),
      'Escape did not close the dialog');
    expect(await stillEditing(cdp), 'Escape in the dialog did not end the text edit').toBe(true);
    expect(await liveLinks(cdp)).toEqual([]);

    await openLinkDialog(cdp);
    await cdp.typeKeys('https://github.com/itruonghai/deckwerk');
    await cdp.key('Enter', 13);
    await eventually(async () => liveLinks(cdp), 'nothing was inserted at the caret',
      (links) => links.length === 1);
    expect(await liveLinks(cdp)).toEqual([
      { href: 'https://github.com/itruonghai/deckwerk', text: 'github.com/itruonghai/deckwerk' },
    ]);
    // Typing on continues after the link, not inside it.
    await cdp.typeKeys('now');
    await eventually(async () => text(cdp), 'typing after the inserted link was lost',
      (value) => value.endsWith('now'));
    expect(await liveLinks(cdp)).toEqual([
      { href: 'https://github.com/itruonghai/deckwerk', text: 'github.com/itruonghai/deckwerk' },
    ]);
    await wait(50);
    await expectSoundMarkup(cdp, 'after inserting a link at the caret');
  });
});

describe.skipIf(!electronBinary)('Cmd/Ctrl+K at the edges of a link and of a selection', () => {
  it('edits the link the caret ends, and clicking outside the dialog keeps the edit and selection', {
    timeout: 120_000,
  }, async () => {
    const cdp = await open('<p>Read <a href="https://old.example">paper</a> today</p>');
    await enterEditing(cdp, CONTENT);
    // Caret right at the end of "paper": still in the link, as in any editor.
    await cdp.clickTextAtOffset(CONTENT, 'Read pape'.length, 'inside the link');
    await cdp.key('ArrowRight', 39);

    await openLinkDialog(cdp);
    expect(await cdp.evaluate<string>(`document.querySelector('${INPUT}').value`)).toBe('https://old.example');
    // A click on the backdrop cancels: the edit stays open, the caret where it was.
    await cdp.clickAt(8, 8);
    await eventually(async () => cdp.evaluate<boolean>(`!document.querySelector('${DIALOG}')`),
      'clicking outside did not close the dialog');
    expect(await stillEditing(cdp), 'clicking outside the dialog ended the text edit').toBe(true);
    expect(await cdp.evaluate<string>(`(() => {
      const range = getSelection().getRangeAt(0);
      const pre = document.createRange();
      pre.selectNodeContents(document.querySelector('${CONTENT}'));
      pre.setEnd(range.startContainer, range.startOffset);
      return pre.toString().length + ':' + range.collapsed;
    })()`), 'the caret came back where the dialog was opened').toBe(`${'Read paper'.length}:true`);

    await openLinkDialog(cdp);
    await cdp.typeKeys('https://new.example');
    await cdp.key('Enter', 13);
    await eventually(async () => liveLinks(cdp), 'Save at the end of a link did not retarget it',
      (links) => links[0]?.href === 'https://new.example');
    expect(await liveLinks(cdp), 'no second link was inserted').toEqual([{ href: 'https://new.example', text: 'paper' }]);
    await expectSoundMarkup(cdp, 'after editing a link from its end');
  });

  it('explains a selection one link cannot cover, and changes nothing', {
    timeout: 120_000,
  }, async () => {
    const cdp = await open('<p>First line</p><p>Second line</p>');
    await enterEditing(cdp, CONTENT);
    await cdp.selectTextRange(CONTENT, 'First '.length, 'First lineSecond'.length, 'across two paragraphs');

    await openLinkDialog(cdp);
    await cdp.typeKeys('https://example.com');
    await cdp.key('Enter', 13);
    await eventually(async () => cdp.evaluate<string>(
      `document.querySelector('${DIALOG} [role="alert"]')?.textContent ?? ''`),
    'no explanation was shown', (message) => message.includes('one paragraph'));
    expect(await cdp.evaluate<boolean>(`document.activeElement === document.querySelector('${INPUT}')`),
      'the keyboard stayed in the dialog').toBe(true);
    expect(await liveLinks(cdp)).toEqual([]);
    await cdp.key('Escape', 27);
    expect(await stillEditing(cdp)).toBe(true);
    expect(await text(cdp)).toBe('First lineSecond line');
  });
});

describe.skipIf(electronBinary)('Cmd/Ctrl+K links text (skipped)', () => {
  it('needs Electron', () => expect(electronBinary).toBe(''));
});
