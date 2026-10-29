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
 * Speaker View's two dividers, dragged with a real mouse: the one beside the
 * current slide widens the side column, the one above the notes makes them
 * taller, the previews re-fit, and a reload keeps the split.
 */

const DECK_ID = 'speaker-split';

function deck(): Deck {
  const base = emptyDeck('Split');
  base.slides = ['ONE', 'TWO'].map((text, index) => ({
    ...structuredClone(base.slides[0]),
    id: `s${index + 1}`,
    name: text,
    notes: 'Notes for the presenter.\n'.repeat(30),
    elements: [{
      id: `t${index + 1}`, type: 'text' as const, x: 160, y: 400, w: 1600, h: 200,
      rot: 0, z: 1, opacity: 1, class: [], style: {},
      html: text, align: 'center' as const, valign: 'middle' as const,
    }],
  }));
  return base;
}

const BOXES = `(() => {
  const box = (selector) => {
    const { x, y, width, height } = document.querySelector(selector).getBoundingClientRect();
    return { x, y, width, height };
  };
  const stage = document.querySelector('.speaker-next .stage').getBoundingClientRect();
  return {
    sidebar: box('.speaker-sidebar').width,
    notes: box('.notes-panel').height,
    column: box('.speaker-sidebar-splitter'),
    row: box('.speaker-notes-splitter'),
    next: box('.speaker-next'),
    stage: { width: stage.width, height: stage.height },
  };
})()`;

interface Rect { x: number; y: number; width: number; height: number }

interface Boxes {
  sidebar: number;
  notes: number;
  column: Rect;
  row: Rect;
  next: Rect;
  stage: { width: number; height: number };
}

let workDir = '';
let server: RunningCollabServer | null = null;
let browser: RunningBrowser | null = null;
let page: Cdp | null = null;

afterEach(async () => {
  page?.close();
  page = null;
  await stopBrowser(browser?.process ?? null);
  browser = null;
  await server?.close();
  server = null;
  if (workDir) await rm(workDir, { recursive: true, force: true, maxRetries: 5 });
  workDir = '';
});

describe.skipIf(!electronBinary)('resizing Speaker View', () => {
  it('drags the column and notes dividers, re-fits the previews, and keeps the split', async () => {
    workDir = await mkdtemp(join(tmpdir(), 'collab-speaker-split-'));
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
      `http://127.0.0.1:${server.port}/present.html?deck=${DECK_ID}&role=speaker`,
      profileDir,
    );
    const target = await findTarget(browser.debugPort, (t) => t.url.includes('role=speaker'), browser.log);
    page = await Cdp.connect(target.webSocketDebuggerUrl!);
    const speaker = page;
    await eventually(
      async () => speaker.evaluate<boolean>(`!!document.querySelector('.speaker-next .stage')`),
      'Speaker View did not show the deck',
      (ready) => ready,
    );
    const before = await speaker.evaluate<Boxes>(BOXES);

    // Widen the side column by 150px.
    const cx = before.column.x + before.column.width / 2;
    const cy = before.column.y + before.column.height / 2;
    const column = await speaker.beginDrag(cx, cy);
    await column.moveTo(cx - 75, cy);
    await column.moveTo(cx - 150, cy);
    await column.drop();
    const wider = await eventually(
      async () => speaker.evaluate<Boxes>(BOXES),
      'the side column did not follow the divider',
      (boxes) => Math.abs(boxes.sidebar - (before.sidebar + 150)) < 6,
    );
    // The next preview re-fit to its larger box.
    await eventually(
      async () => speaker.evaluate<Boxes>(BOXES),
      'the next preview did not re-fit',
      (boxes) => boxes.stage.width > before.stage.width + 50,
    );

    // Make the notes 200px taller.
    const rx = wider.row.x + wider.row.width / 2;
    const ry = wider.row.y + wider.row.height / 2;
    const row = await speaker.beginDrag(rx, ry);
    await row.moveTo(rx, ry - 100);
    await row.moveTo(rx, ry - 200);
    await row.drop();
    const taller = await eventually(
      async () => speaker.evaluate<Boxes>(BOXES),
      'the notes did not follow the divider',
      (boxes) => Math.abs(boxes.notes - (wider.notes + 200)) < 8,
    );
    // The next preview gave up the height and still fits inside its box.
    expect(taller.next.height).toBeLessThan(wider.next.height);
    expect(taller.stage.height).toBeLessThanOrEqual(taller.next.height + 1);

    // A reload keeps the split.
    await speaker.evaluate('location.reload(), true');
    await eventually(
      async () => speaker.evaluate<boolean>(`!!document.querySelector('.speaker-next .stage')`),
      'Speaker View did not come back',
      (ready) => ready,
    );
    const reloaded = await speaker.evaluate<Boxes>(BOXES);
    expect(Math.abs(reloaded.sidebar - taller.sidebar)).toBeLessThan(4);
    expect(Math.abs(reloaded.notes - taller.notes)).toBeLessThan(4);
  }, 90_000);
});
