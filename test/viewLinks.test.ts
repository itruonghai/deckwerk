/**
 * The view-link door (--view-port): "anyone with the link can view, no
 * sign-in". Nobody is anybody on it; a deck opens only through its link
 * secret, view-only, while its owner has the link set to "anyone", and stops
 * the moment the link is turned off, reset or made sign-in-only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { emptyDeck, parseDeck } from '../src/shared/deck.js';
import { saveDeck } from '../src/main/deckStore.js';
import { COLLAB_PROTOCOL_VERSION, ServerMessageSchema } from '../src/shared/collab.js';
import { startCollabServer, type RunningCollabServer } from '../src/server/collabServer.js';

const ADMIN = 'owner@example.com';

describe('collab server view-link door', () => {
  let rootDir: string;
  let server: RunningCollabServer;
  let sockets: WebSocket[] = [];

  const seedDeck = async (id: string, access?: object, slide: object = {}) => {
    const dir = join(rootDir, id);
    await mkdir(dir, { recursive: true });
    await saveDeck(dir, parseDeck({ ...emptyDeck(id), slides: [{ id: 's1', name: 'One', ...slide }] }));
    await writeFile(join(dir, 'theme.css'), '/* t */\n', 'utf8');
    if (access) await writeFile(join(dir, 'access.json'), JSON.stringify(access), 'utf8');
  };

  const view = async (path: string, headers: Record<string, string> = {}) => {
    const response = await fetch(`http://127.0.0.1:${server.viewPort}${path}`, { headers, redirect: 'manual' });
    return {
      status: response.status,
      cookie: response.headers.get('set-cookie'),
      location: response.headers.get('location'),
      body: await response.json().catch(() => null) as any,
    };
  };
  /** The owner, on the tailnet port (bare loopback = admin). */
  const setLink = async (deck: string, link: string) => {
    const response = await fetch(`http://127.0.0.1:${server.port}/api/access?deck=${deck}`, {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ link }),
    });
    return { status: response.status, body: await response.json() as any };
  };
  /** The secret in a link (sign-in links are relative here: this server has no Cloudflare address). */
  const tokenOf = (linkUrl: string) => {
    const params = new URL(linkUrl, 'https://relative.invalid').searchParams;
    return params.get('view') ?? params.get('invite')!;
  };
  const cookieFor = (setCookie: string) => setCookie.split(';')[0];

  const wsResult = (deckId: string, headers: Record<string, string>, untilClose = false, onWelcome?: () => void) =>
    new Promise<{ closed?: number; welcome?: boolean }>((resolvePromise, reject) => {
      let welcomed = false;
      const socket = new WebSocket(`ws://127.0.0.1:${server.viewPort}/ws?deck=${encodeURIComponent(deckId)}`, { headers });
      sockets.push(socket);
      socket.on('open', () => socket.send(JSON.stringify({ kind: 'hello', version: COLLAB_PROTOCOL_VERSION })));
      socket.on('message', (raw) => {
        ServerMessageSchema.parse(JSON.parse(String(raw)));
        if (!welcomed) onWelcome?.();
        welcomed = true;
        if (!untilClose) resolvePromise({ welcome: true });
      });
      socket.on('close', (code) => resolvePromise(welcomed ? { welcome: true, closed: code } : { closed: code }));
      socket.on('error', reject);
      setTimeout(() => reject(new Error('ws timed out')), 4000);
    });

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), 'collab-view-links-'));
    await seedDeck('talk', { owner: ADMIN, visibility: 'private', sharedWith: [] }, {
      notes: 'SECRET-SPEAKER-NOTES',
      comments: [{ id: 'c1', author: 'Rev', text: 'SECRET-REVIEW-COMMENT', ts: '2026-10-14T00:00:00Z' }],
    });
    await seedDeck('other', { owner: ADMIN, visibility: 'private', sharedWith: [] });
    await seedDeck('legacy'); // no sidecar: public to the tailnet
    server = await startCollabServer({
      rootDir,
      port: 0,
      host: '127.0.0.1',
      accessControl: { admin: ADMIN },
      viewLinks: { port: 0, publicUrl: 'https://view.example.com' },
    });
  });

  afterEach(async () => {
    for (const socket of sockets) socket.terminate();
    sockets = [];
    await server.close();
    await rm(rootDir, { recursive: true, force: true });
  });

  it('opens nothing without a link — whatever the request claims to be', async () => {
    for (const path of ['/', '/api/config', '/api/decks', '/api/config?deck=legacy']) {
      expect((await view(path)).status).toBe(403);
    }
    expect((await view('/api/config', { 'tailscale-user-login': ADMIN })).status).toBe(403);
    expect((await view('/api/config', { 'cf-access-jwt-assertion': 'x.y.z' })).status).toBe(403);
    expect((await view(`/api/config?deck=talk&view=${'a'.repeat(24)}`)).status).toBe(403);
  });

  it('opens one deck, view-only, through its "anyone" link, and keeps it open by cookie', async () => {
    const { body } = await setLink('talk', 'anyone');
    expect(body.link.anyone).toBe(true);
    expect(body.anyoneLinks).toBe(true);
    const link = new URL(body.linkUrl);
    expect(link.origin).toBe('https://view.example.com');
    const token = tokenOf(body.linkUrl);

    // The page itself: sent to the presentation page, with the secret kept in a cookie.
    const page = await view(`/?deck=talk&view=${token}`);
    expect(page.status).toBe(302);
    expect(page.location).toMatch(/^\/present\.html\?/);
    expect(page.cookie).toMatch(/HttpOnly/);
    expect(page.cookie).toMatch(/Secure/);
    const cookie = { cookie: cookieFor(page.cookie!) };

    expect((await view('/api/config?deck=talk', cookie)).status).toBe(200);
    // Not even the list of decks: the link is to one presentation.
    expect((await view('/api/decks', cookie)).status).toBe(403);
    expect((await view('/api/config?deck=other', cookie)).status).toBe(403);
    expect((await view('/api/config?deck=legacy', cookie)).status).toBe(403);
    // Watching only: not the source, not the chat, not who it is shared with, not the people here.
    for (const path of ['/api/download?deck=talk', '/api/chat?deck=talk', '/api/access?deck=talk', '/api/users',
      '/api/deck?deck=talk', '/api/comments?deck=talk', '/api/text?deck=talk', '/api/context?deck=talk',
      '/api/render-slide?deck=talk&slide=1', '/api/agent-mirror/files?deck=talk', '/api/export/web?deck=talk']) {
      // (The agent-mirror routes are not even routed for a browser: 404.)
      expect([403, 404], path).toContain((await view(path, cookie)).status);
    }
    const write = await fetch(`http://127.0.0.1:${server.viewPort}/api/comments?deck=talk`, {
      method: 'POST', headers: { ...cookie, 'content-type': 'application/json' }, body: '{}',
    });
    expect(write.status).toBe(403);
    // A link viewer is nobody: never added to the deck, never in the people list.
    const access = (await fetch(`http://127.0.0.1:${server.port}/api/access?deck=talk`).then((r) => r.json())) as any;
    expect(access.sharedWith).toEqual([]);
    const users = (await fetch(`http://127.0.0.1:${server.port}/api/users`).then((r) => r.json())) as any[];
    expect(users.map((user) => user.login)).not.toContain('link-viewer');
  });

  it('does not open a deck whose link needs signing in', async () => {
    const { body } = await setLink('talk', 'on');
    expect(body.link.anyone).toBe(false);
    expect(new URL(body.linkUrl, 'https://relative.invalid').searchParams.has('invite')).toBe(true);
    const token = tokenOf(body.linkUrl);
    expect((await view(`/api/config?deck=talk&view=${token}`)).status).toBe(403);
    // An invite on this door joins nobody to anything.
    expect((await view(`/api/config?deck=talk&invite=${token}`)).status).toBe(403);
  });

  it('cuts viewers off — live sockets included — when the link is reset, made sign-in-only, or turned off', async () => {
    for (const next of ['reset', 'on', 'off']) {
      const { body } = await setLink('talk', 'anyone');
      const token = tokenOf(body.linkUrl);
      const page = await view(`/?deck=talk&view=${token}`);
      const cookie = { cookie: cookieFor(page.cookie!) };
      let welcomed: () => void = () => {};
      const ready = new Promise<void>((resolveReady) => { welcomed = resolveReady; });
      const live = wsResult('talk', cookie, true, () => welcomed());
      await ready;
      await setLink('talk', next);
      expect(await live).toEqual({ welcome: true, closed: 4003 });
      expect((await view('/api/config?deck=talk', cookie)).status).toBe(403);
      await setLink('talk', 'off');
    }
  });

  it('keeps each deck to its own link, for a browser holding several', async () => {
    const talk = tokenOf((await setLink('talk', 'anyone')).body.linkUrl);
    const other = tokenOf((await setLink('other', 'anyone')).body.linkUrl);
    const a = cookieFor((await view(`/?deck=talk&view=${talk}`)).cookie!);
    const b = cookieFor((await view(`/?deck=other&view=${other}`)).cookie!);
    expect(a.split('=')[0]).not.toBe(b.split('=')[0]);
    const both = { cookie: `${a}; ${b}` };
    expect((await view('/api/config?deck=talk', both)).status).toBe(200);
    expect((await view('/api/config?deck=other', both)).status).toBe(200);
    expect((await view('/api/config?deck=other', { cookie: a })).status).toBe(403);
    await setLink('other', 'off');
    expect((await view('/api/config?deck=other', both)).status).toBe(403);
    expect((await view('/api/config?deck=talk', both)).status).toBe(200);
  });

  it('refuses "anyone" links on a server without a view-link address, and a door without access control', async () => {
    const plain = await startCollabServer({ rootDir, port: 0, host: '127.0.0.1', accessControl: { admin: ADMIN } });
    try {
      const response = await fetch(`http://127.0.0.1:${plain.port}/api/access?deck=talk`, {
        method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ link: 'anyone' }),
      });
      expect(response.status).toBe(400);
    } finally {
      await plain.close();
    }
    await expect(startCollabServer({ rootDir, port: 0, host: '127.0.0.1', viewLinks: { port: 0 } }))
      .rejects.toThrow(/accessControl/);
  });

  it('shows a link viewer the slides, never the chat, speaker notes or review comments', async () => {
    const token = tokenOf((await setLink('talk', 'anyone')).body.linkUrl);
    const cookie = { cookie: cookieFor((await view(`/?deck=talk&view=${token}`)).cookie!) };
    // Someone on the team says something in the deck chat.
    const chat = await fetch(`http://127.0.0.1:${server.port}/api/chat?deck=talk`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'SECRET-CHAT-LINE' }),
    });
    expect(chat.status).toBe(200);

    const frames: string[] = [];
    const socket = new WebSocket(`ws://127.0.0.1:${server.viewPort}/ws?deck=talk`, { headers: cookie });
    sockets.push(socket);
    await new Promise<void>((resolveOpen, reject) => {
      socket.on('open', () => socket.send(JSON.stringify({ kind: 'hello', version: COLLAB_PROTOCOL_VERSION })));
      socket.on('message', (raw) => {
        frames.push(String(raw));
        if (frames.length === 1) resolveOpen();
      });
      socket.on('error', reject);
    });
    const welcome = JSON.parse(frames[0]);
    expect(welcome.kind).toBe('welcome');
    expect(welcome.deck.slides[0].name).toBe('One');
    expect(welcome.chat).toEqual([]);

    // Live: more chat, a new comment, new notes — none of it reaches the viewer;
    // a slide edit does.
    await fetch(`http://127.0.0.1:${server.port}/api/chat?deck=talk`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'SECRET-LIVE-CHAT' }),
    });
    const editor = new WebSocket(`ws://127.0.0.1:${server.port}/ws?deck=talk`);
    sockets.push(editor);
    await new Promise<void>((resolveOpen) => {
      editor.on('open', () => editor.send(JSON.stringify({ kind: 'hello', version: COLLAB_PROTOCOL_VERSION })));
      editor.once('message', () => resolveOpen());
    });
    editor.send(JSON.stringify({
      kind: 'txn', txnId: 't1', baseSeq: welcome.seq, label: 'notes',
      ops: [
        { op: 'setSlideProperties', slideId: 's1', slide: { id: 's1', name: 'Renamed', notes: 'SECRET-LIVE-NOTES' } },
        { op: 'updateComments', slideId: 's1', base: [], comments: [{ id: 'c2', author: 'Rev', text: 'SECRET-LIVE-COMMENT', ts: '2026-10-14T00:00:01Z' }] },
      ],
    }));
    await vi.waitFor(() => expect(frames.some((frame) => frame.includes('Renamed'))).toBe(true));
    const everything = frames.join('\n');
    for (const secret of ['SECRET-SPEAKER-NOTES', 'SECRET-REVIEW-COMMENT', 'SECRET-CHAT-LINE', 'SECRET-LIVE-CHAT',
      'SECRET-LIVE-NOTES', 'SECRET-LIVE-COMMENT']) {
      expect(everything).not.toContain(secret);
    }
  });
});
