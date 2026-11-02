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
  type RunningBrowser,
} from './support/browserSession.js';
import { collabClientDir } from './support/collabClient.js';

/**
 * Present in a browser that can see a second screen (Chrome's Window
 * Management API on a laptop with a projector): the audience opens in a window
 * filling the projector and the editor tab becomes Speaker View on the laptop,
 * from one real click.
 *
 * BUG (fixed): the editor tab went fullscreen on the projector and then opened
 * Speaker View as a pop-up. Chrome on macOS makes a pop-up from a fullscreen
 * window a tab of that window; switching to it ended the fullscreen and hid
 * the audience behind Speaker View in the editor's window.
 *
 * BUG (fixed): Present never looked at the screens. The audience went
 * fullscreen over the editor on the laptop, and Speaker View told the
 * presenter to drag a window to the projector.
 *
 * A test machine has one screen, so the API's answers are stubbed in the
 * editor tab: two screens and permission granted; window.open records where
 * it was asked to put the window and whether the click still counted.
 * Everything else is real: the click's user activation surviving the awaits,
 * the present page in both roles, the bus between them, and ending the show
 * from Speaker View.
 */

const SLIDES = ['ALPHA SLIDE', 'BRAVO SLIDE', 'CHARLIE SLIDE'];
const DECK_ID = 'two-screens';
const USER = 'Presenter';

function deck(): Deck {
  const base = emptyDeck('Two screens');
  base.slides = SLIDES.map((text, index) => ({
    ...structuredClone(base.slides[0]),
    id: `s${index + 1}`,
    name: text,
    elements: [{
      id: `t${index + 1}`, type: 'text' as const, x: 160, y: 400, w: 1600, h: 200,
      rot: 0, z: 1, opacity: 1, class: [], style: {},
      html: text, align: 'center' as const, valign: 'middle' as const,
    }],
  }));
  return base;
}

/** A MacBook with a projector to its right, as Chrome would describe them. */
const TWO_SCREENS = `(() => {
  const laptop = {
    label: 'Built-in Retina Display', isInternal: true, isPrimary: true, isExtended: true,
    left: 0, top: 0, width: 1512, height: 982,
    availLeft: 0, availTop: 25, availWidth: 1512, availHeight: 957,
  };
  const projector = {
    label: 'Projector', isInternal: false, isPrimary: false, isExtended: true,
    left: 1512, top: 0, width: 1920, height: 1080,
    availLeft: 1512, availTop: 0, availWidth: 1920, availHeight: 1080,
  };
  Object.defineProperty(Screen.prototype, 'isExtended', { configurable: true, get: () => true });
  window.getScreenDetails = async () => ({ screens: [laptop, projector], currentScreen: laptop });
  const query = navigator.permissions.query.bind(navigator.permissions);
  navigator.permissions.query = (descriptor) => descriptor && descriptor.name === 'window-management'
    ? Promise.resolve({ state: 'granted' })
    : query(descriptor);
  window.__fullscreenScreens = [];
  window.__activationAtFullscreen = [];
  const requestFullscreen = Element.prototype.requestFullscreen;
  Element.prototype.requestFullscreen = function (options) {
    window.__fullscreenScreens.push(options && options.screen ? options.screen.label : null);
    window.__activationAtFullscreen.push(navigator.userActivation.isActive);
    return requestFullscreen.call(this);
  };
  window.__opened = [];
  const open = window.open;
  window.open = function (url, name, features) {
    window.__opened.push({ url: String(url), features: features || '', activation: navigator.userActivation.isActive });
    return open.call(this, url, name, features);
  };
  return true;
})()`;

const SPEAKER_DOC = `document.querySelector('iframe[src*="present.html"]')?.contentDocument`;

/** Ids of the slide text a surface is showing; one id once a move settles. */
function shownProbe(root: string): string {
  return `(() => [...(${root})?.querySelectorAll('[data-element-id^="t"]') ?? []]
    .map((node) => node.getAttribute('data-element-id')))()`;
}

const ACTIVE_RAIL_SLIDE = `document.querySelector('[data-index][data-slide-id].active')?.getAttribute('data-slide-id') ?? null`;

let workDir = '';
let server: RunningCollabServer | null = null;
let browser: RunningBrowser | null = null;
const pages: Cdp[] = [];

afterEach(async () => {
  for (const page of pages.splice(0)) page.close();
  await stopBrowser(browser?.process ?? null);
  browser = null;
  await server?.close();
  server = null;
  if (workDir) await rm(workDir, { recursive: true, force: true, maxRetries: 5 });
  workDir = '';
});

describe.skipIf(!electronBinary)('presenting from the browser with a second screen', () => {
  it('puts the audience on the projector and Speaker View on the laptop from one click', async () => {
    workDir = await mkdtemp(join(tmpdir(), 'collab-two-screens-'));
    const decksRoot = join(workDir, 'decks');
    const deckDir = join(decksRoot, DECK_ID);
    const profileDir = join(workDir, 'electron-profile');
    await mkdir(deckDir, { recursive: true });
    await mkdir(profileDir, { recursive: true });
    await saveDeck(deckDir, deck());
    await writeFile(join(deckDir, 'theme.css'), '.slide { background: #fff; color: #111; }\n', 'utf8');

    server = await startCollabServer({
      rootDir: decksRoot, clientDir: await collabClientDir(), host: '127.0.0.1', port: 0,
    });
    browser = await launchBrowser(
      `http://127.0.0.1:${server.port}/?deck=${DECK_ID}&name=${encodeURIComponent(USER)}`,
      profileDir,
    );
    const target = await findTarget(
      browser.debugPort,
      (t) => t.url.includes(`deck=${DECK_ID}`) && !t.url.includes('present.html'),
      browser.log,
    );
    const editor = await Cdp.connect(target.webSocketDebuggerUrl!);
    pages.push(editor);
    await eventually(
      async () => editor.evaluate<boolean>(
        `document.getElementById('status')?.textContent?.includes(${JSON.stringify(`connected as ${USER}`)}) === true`,
      ),
      'browser editor did not finish connecting',
    );
    expect(await editor.evaluate<boolean>(TWO_SCREENS)).toBe(true);

    // Plain Present, not the Speaker View entry: with a second screen,
    // Speaker View is automatic, as in the desktop app.
    await editor.clickByText('#toolbar button', 'Present', 'Present');

    // The audience: a window filling the projector, opened while the click counted.
    const opened = await eventually(
      async () => editor.evaluate<Array<{ url: string; features: string; activation: boolean }>>('window.__opened'),
      'the audience window did not open',
      (list) => list.length === 1,
    );
    expect(new URL(opened[0].url, 'http://x/').searchParams.get('role')).toBeNull();
    expect(opened[0].features).toBe('popup,left=1512,top=0,width=1920,height=1080');
    expect(opened[0].activation).toBe(true);
    // Nothing went fullscreen in the editor's window, so nothing was opened from one.
    expect(await editor.evaluate<Array<string | null>>('window.__fullscreenScreens')).toEqual([]);

    const audienceTarget = await findTarget(
      browser.debugPort,
      (t) => t.url.includes('present.html') && !t.url.includes('role=speaker') && !t.url.includes('embed=1'),
      browser.log,
    );
    const audience = await Cdp.connect(audienceTarget.webSocketDebuggerUrl!);
    pages.push(audience);
    await eventually(
      async () => audience.evaluate<string[]>(shownProbe(`document.getElementById('stage')`)),
      'the audience window did not paint its first slide',
      (ids) => ids.length === 1 && ids[0] === 't1',
    );

    // Speaker View: this tab's overlay.
    const overlaySrc = await editor.evaluate<string>(`document.querySelector('iframe[src*="present.html"]').src`);
    expect(new URL(overlaySrc).searchParams.get('role')).toBe('speaker');
    await eventually(
      async () => editor.evaluate<string | null>(
        `${SPEAKER_DOC}?.querySelector('.speaker-current .slide')?.textContent?.trim() ?? null`,
      ),
      'Speaker View did not show the running presentation',
      (text) => text === 'ALPHA SLIDE',
    );

    await editor.evaluate(`${SPEAKER_DOC}.querySelector('.speaker-next-button').click(), true`);
    await eventually(
      async () => audience.evaluate<string[]>(shownProbe(`document.getElementById('stage')`)),
      'the projector did not advance when Speaker View pressed Next',
      (ids) => ids.length === 1 && ids[0] === 't2',
    );

    await editor.evaluate(`${SPEAKER_DOC}.querySelector('.speaker-end').click(), true`);
    await eventually(
      async () => editor.evaluate<boolean>(`!document.querySelector('iframe[src*="present.html"]')`),
      'ending the show in Speaker View left it up',
      (gone) => gone,
    );
    await eventually(
      async () => (await fetch(`http://127.0.0.1:${browser!.debugPort}/json/list`)).json() as Promise<Array<{ url: string }>>,
      'ending the show left the projector window open',
      (targets) => !targets.some((t) => t.url.includes('present.html')),
    );
    await eventually(
      async () => editor.evaluate<string | null>(ACTIVE_RAIL_SLIDE),
      'leaving the show did not land the editor on the slide it ended on',
      (id) => id === 's2',
    );
  }, 90_000);
});
