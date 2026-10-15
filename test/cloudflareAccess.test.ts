/**
 * The Cloudflare Access door (--cloudflare-team / --cloudflare-aud): the
 * token check on its own, then the server wiring — a listener where the only
 * identity is a verified token, beside a tailscale port that is unchanged.
 *
 * Tokens are signed here with a generated RSA key, published to the verifier
 * through a fake fetch of the team's certs endpoint, exactly as Cloudflare
 * publishes its own.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { emptyDeck, parseDeck } from '../src/shared/deck.js';
import { saveDeck } from '../src/main/deckStore.js';
import { COLLAB_PROTOCOL_VERSION, ServerMessageSchema } from '../src/shared/collab.js';
import { startCollabServer, type RunningCollabServer } from '../src/server/collabServer.js';
import { createCloudflareAccessVerifier, normalizeTeamDomain } from '../src/server/cloudflareAccess.js';
import { LocalAgentRegistry } from '../src/server/localAgents.js';

const TEAM = 'lab.cloudflareaccess.com';
const AUD = 'aud-tag-0123456789';
const ADMIN = 'owner@example.com';
const PROF = 'prof@university.example';

function keyPair(kid: string) {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  return { kid, privateKey, jwk: { ...publicKey.export({ format: 'jwk' }), kid, alg: 'RS256', use: 'sig' } };
}

function token(
  key: { kid: string; privateKey: KeyObject },
  claims: Record<string, unknown>,
  header: Record<string, unknown> = {},
): string {
  const now = Math.floor(Date.now() / 1000);
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const head = encode({ alg: 'RS256', kid: key.kid, typ: 'JWT', ...header });
  const body = encode({ iss: `https://${TEAM}`, aud: [AUD], iat: now, nbf: now, exp: now + 600, type: 'app', ...claims });
  const signature = sign('RSA-SHA256', Buffer.from(`${head}.${body}`), key.privateKey).toString('base64url');
  return `${head}.${body}.${signature}`;
}

/** A certs endpoint serving `published`, counting how often it is asked. */
function certsEndpoint(published: { jwk: object }[]) {
  const calls: string[] = [];
  return {
    calls,
    published,
    fetch: async (url: string) => {
      calls.push(url);
      return { ok: true, status: 200, json: async () => ({ keys: published.map((key) => key.jwk) }) };
    },
  };
}

describe('Cloudflare Access token check', () => {
  const key = keyPair('k1');

  it('accepts a token for this team and application, as the lower-cased email', async () => {
    const certs = certsEndpoint([key]);
    const verifier = createCloudflareAccessVerifier({ teamDomain: TEAM, audience: AUD }, { fetch: certs.fetch });
    expect(await verifier.verifyToken(token(key, { email: 'Prof@University.Example' })))
      .toEqual({ login: PROF, name: PROF, external: true });
    expect(certs.calls).toEqual([`https://${TEAM}/cdn-cgi/access/certs`]);
    // Keys are kept, not fetched per request.
    await verifier.verifyToken(token(key, { email: PROF }));
    expect(certs.calls).toHaveLength(1);
  });

  it('refuses tokens that are not exactly ours', async () => {
    const stranger = keyPair('k1'); // same key id, different key
    const verifier = createCloudflareAccessVerifier(
      { teamDomain: TEAM, audience: AUD }, { fetch: certsEndpoint([key]).fetch },
    );
    const now = Math.floor(Date.now() / 1000);
    const refused = [
      token(stranger, { email: PROF }),
      token(key, { email: PROF, aud: ['another-application'] }),
      token(key, { email: PROF, iss: 'https://other.cloudflareaccess.com' }),
      token(key, { email: PROF, exp: now - 3600 }),
      token(key, { email: PROF, nbf: now + 3600 }),
      token(key, { common_name: 'service-token.access' }), // a service token is not a person
      token(key, { email: PROF }, { alg: 'HS256' }),
      token(key, { email: PROF }, { kid: 'unknown' }),
      'not.a.token',
      '',
    ];
    for (const candidate of refused) expect(await verifier.verifyToken(candidate)).toBeNull();
    // "alg: none" with the signature stripped.
    const [head, body] = token(key, { email: PROF }).split('.');
    const none = `${Buffer.from(JSON.stringify({ alg: 'none', kid: 'k1' })).toString('base64url')}.${body}.`;
    expect(await verifier.verifyToken(none)).toBeNull();
    expect(await verifier.verifyToken(`${head}.${body}.`)).toBeNull();
  });

  it('picks up a rotated key, without refetching on every unknown key id', async () => {
    let clock = Date.now();
    const certs = certsEndpoint([key]);
    const verifier = createCloudflareAccessVerifier(
      { teamDomain: TEAM, audience: AUD }, { fetch: certs.fetch, now: () => clock },
    );
    expect(await verifier.verifyToken(token(key, { email: PROF }))).not.toBeNull();
    const rotated = keyPair('k2');
    certs.published.push(rotated);
    // Just fetched: an unknown key id waits for the refetch interval.
    expect(await verifier.verifyToken(token(rotated, { email: PROF }))).toBeNull();
    expect(certs.calls).toHaveLength(1);
    clock += 31_000;
    expect(await verifier.verifyToken(token(rotated, { email: PROF }))).not.toBeNull();
    expect(certs.calls).toHaveLength(2);
  });

  it('stops trusting keys it has not been able to refresh for hours, and recovers', async () => {
    let clock = Date.now();
    let reachable = true;
    const certs = certsEndpoint([key]);
    const verifier = createCloudflareAccessVerifier({ teamDomain: TEAM, audience: AUD }, {
      now: () => clock,
      fetch: async (url) => {
        if (!reachable) throw new Error('offline');
        return certs.fetch(url);
      },
    });
    const fresh = () => token(key, { email: PROF, exp: Math.floor(clock / 1000) + 600 });
    expect(await verifier.verifyToken(fresh())).not.toBeNull();
    reachable = false;
    clock += 2 * 60 * 60 * 1000; // a refresh is due and fails: the keys still serve
    expect(await verifier.verifyToken(fresh())).not.toBeNull();
    clock += 5 * 60 * 60 * 1000; // past the stale limit: nobody gets in
    expect(await verifier.verifyToken(fresh())).toBeNull();
    reachable = true;
    clock += 31_000;
    expect(await verifier.verifyToken(fresh())).not.toBeNull();
  });

  it('treats a key set with no usable keys as a failed fetch', async () => {
    let published: object[] = [];
    let clock = Date.now();
    const verifier = createCloudflareAccessVerifier({ teamDomain: TEAM, audience: AUD }, {
      now: () => clock,
      fetch: async () => ({ ok: true, status: 200, json: async () => ({ keys: published }) }),
    });
    expect(await verifier.verifyToken(token(key, { email: PROF }))).toBeNull();
    published = [key.jwk];
    clock += 31_000;
    expect(await verifier.verifyToken(token(key, { email: PROF }))).not.toBeNull();
  });

  it('normalizes the team domain however it is typed, and refuses non-domains', () => {
    expect(normalizeTeamDomain(' https://Lab.CloudflareAccess.com/ ')).toBe(TEAM);
    expect(() => normalizeTeamDomain('lab')).toThrow();
    expect(() => normalizeTeamDomain('lab.example.com/path')).toThrow();
  });
});

describe('collab server Cloudflare Access door', () => {
  const key = keyPair('k1');
  let rootDir: string;
  let server: RunningCollabServer;
  let sockets: WebSocket[] = [];

  const seedDeck = async (id: string, access?: object) => {
    const dir = join(rootDir, id);
    await mkdir(dir, { recursive: true });
    await saveDeck(dir, parseDeck({ ...emptyDeck(id), slides: [{ id: 's1', name: 'One' }] }));
    await writeFile(join(dir, 'theme.css'), '/* t */\n', 'utf8');
    if (access) await writeFile(join(dir, 'access.json'), JSON.stringify(access), 'utf8');
  };

  const get = async (port: number, path: string, headers: Record<string, string> = {}) => {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, { headers });
    return { status: response.status, body: await response.json().catch(() => null) as any };
  };
  const as = (email: string) => ({ 'cf-access-jwt-assertion': token(key, { email }) });

  const wsResult = (port: number, deckId: string, headers: Record<string, string>, untilClose = false) =>
    new Promise<{ closed?: number; welcome?: boolean }>((resolvePromise, reject) => {
      let welcomed = false;
      const socket = new WebSocket(`ws://127.0.0.1:${port}/ws?deck=${encodeURIComponent(deckId)}`, { headers });
      sockets.push(socket);
      socket.on('open', () => socket.send(JSON.stringify({ kind: 'hello', version: COLLAB_PROTOCOL_VERSION })));
      socket.on('message', (raw) => {
        ServerMessageSchema.parse(JSON.parse(String(raw)));
        welcomed = true;
        if (!untilClose) resolvePromise({ welcome: true });
      });
      socket.on('close', (code) => resolvePromise(welcomed ? { welcome: true, closed: code } : { closed: code }));
      socket.on('error', reject);
      setTimeout(() => reject(new Error('ws timed out')), 4000);
    });

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), 'collab-cloudflare-'));
    await seedDeck('private', { owner: ADMIN, visibility: 'private', sharedWith: [] });
    await seedDeck('for-prof', { owner: ADMIN, visibility: 'private', sharedWith: [{ login: PROF, role: 'view' }] });
    await seedDeck('legacy'); // no sidecar: public to the tailnet, editable
    server = await startCollabServer({
      rootDir,
      port: 0,
      host: '127.0.0.1',
      accessControl: { admin: ADMIN },
      localAgents: new LocalAgentRegistry({ name: 'Agent' }),
      cloudflareAccess: {
        teamDomain: TEAM,
        audience: AUD,
        port: 0,
        publicUrl: 'https://slides.example.com',
        verifier: createCloudflareAccessVerifier({ teamDomain: TEAM, audience: AUD }, { fetch: certsEndpoint([key]).fetch }),
      },
    });
  });

  afterEach(async () => {
    for (const socket of sockets) socket.terminate();
    sockets = [];
    await server.close();
    await rm(rootDir, { recursive: true, force: true });
  });

  it('is nobody without a valid token — not the machine owner, whatever headers say', async () => {
    const port = server.cloudflarePort!;
    expect((await get(port, '/api/config')).status).toBe(403);
    expect((await get(port, '/api/config', { 'tailscale-user-login': ADMIN })).status).toBe(403);
    expect((await get(port, '/api/config', { 'cf-access-jwt-assertion': 'forged.token.here' })).status).toBe(403);
    expect((await get(port, '/')).status).toBe(403);
  });

  it('is the person the token names, with their own deck permissions', async () => {
    const port = server.cloudflarePort!;
    expect((await get(port, '/api/config', as(PROF))).body.access).toMatchObject({ user: PROF, admin: false });
    // A Tailscale header beside the token changes nothing.
    expect((await get(port, '/api/config', { ...as(PROF), 'tailscale-user-login': ADMIN })).body.access)
      .toMatchObject({ user: PROF, admin: false });
    expect(((await get(port, '/api/decks', as(PROF))).body as any[]).map((deck) => deck.id)).toEqual(['for-prof']);
    expect((await get(port, '/api/deck?deck=private', as(PROF))).status).toBe(403);
    expect((await get(port, '/api/deck?deck=for-prof', as(PROF))).status).toBe(200);
    // The admin signing in through Cloudflare with the admin email is the admin.
    expect((await get(port, '/api/config', as(ADMIN))).body.access).toMatchObject({ user: ADMIN, admin: true });
  });

  it('treats people from the internet as guests: no public decks, nothing beyond their decks', async () => {
    const port = server.cloudflarePort!;
    expect(((await get(port, '/api/decks', as(PROF))).body as any[]).map((deck) => deck.id)).toEqual(['for-prof']);
    expect((await get(port, '/api/deck?deck=legacy', as(PROF))).status).toBe(403);
    expect((await get(port, '/api/users', as(PROF))).status).toBe(403);
    expect((await get(port, '/api/trash', as(PROF))).status).toBe(403);
    const create = await fetch(`http://127.0.0.1:${port}/api/decks?name=mine`, { method: 'POST', headers: as(PROF) });
    expect(create.status).toBe(403);
    // On the tailnet "public" still means public.
    expect((await get(server.port, '/api/deck?deck=legacy', { 'tailscale-user-login': PROF })).status).toBe(200);
    // The admin is the admin through either door.
    expect(((await get(port, '/api/decks', as(ADMIN))).body as any[]).map((deck) => deck.id)).toContain('legacy');
  });

  it('lets anyone with the link in as a named viewer, until the link is reset', async () => {
    const port = server.cloudflarePort!;
    const put = (body: object) => fetch(`http://127.0.0.1:${server.port}/api/access?deck=private`, {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    }).then(async (response) => ({ status: response.status, body: await response.json() as any }));

    const on = await put({ link: 'on' });
    expect(on.status).toBe(200);
    const link = new URL(on.body.linkUrl);
    expect(link.origin).toBe('https://slides.example.com');
    const invite = link.searchParams.get('invite')!;
    expect(invite.length).toBeGreaterThanOrEqual(20);
    // 'on' again keeps the link already sent.
    expect((await put({ link: 'on' })).body.linkUrl).toBe(on.body.linkUrl);

    const stranger = 'stranger@elsewhere.example';
    expect((await get(port, `/api/deck?deck=private&invite=${invite.slice(0, -1)}x`, as(stranger))).status).toBe(403);
    expect((await get(port, `/?deck=private&invite=${invite}`, as(stranger))).status).not.toBe(403);
    // Now a named viewer: no invite needed, and listed for the owner.
    expect((await get(port, '/api/deck?deck=private', as(stranger))).status).toBe(200);
    const access = (await get(server.port, '/api/access?deck=private')).body;
    expect(access.sharedWith).toContainEqual({ login: stranger, role: 'view' });
    // A viewer neither edits nor learns the link.
    const viewerAccess = (await get(port, '/api/access?deck=private', as(stranger))).body;
    expect(viewerAccess).toMatchObject({ role: 'view', link: null, linkUrl: null });
    const write = await fetch(`http://127.0.0.1:${port}/api/access?deck=private`, {
      method: 'PUT', headers: { ...as(stranger), 'content-type': 'application/json' }, body: JSON.stringify({ link: 'off' }),
    });
    expect(write.status).toBe(403);

    // Reset: the old link lets nobody new in.
    expect((await put({ link: 'reset' })).body.linkUrl).not.toBe(on.body.linkUrl);
    expect((await get(port, `/api/deck?deck=private&invite=${invite}`, as('late@elsewhere.example'))).status).toBe(403);
    expect((await put({ link: 'off' })).body.linkUrl).toBeNull();
  });

  it('keeps the link secret and the other members from people who do not manage the deck', async () => {
    const port = server.cloudflarePort!;
    const put = (body: object) => fetch(`http://127.0.0.1:${server.port}/api/access?deck=for-prof`, {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    }).then((response) => response.json() as Promise<any>);
    const { linkUrl } = await put({ link: 'on', sharedWith: [{ login: PROF, role: 'view' }, { login: 'other@x.example', role: 'edit' }] });
    const token = new URL(linkUrl).searchParams.get('invite')!;

    const seen = (await get(port, '/api/access?deck=for-prof', as(PROF))).body;
    expect(seen.sharedWith).toEqual([{ login: PROF, role: 'view' }]);
    expect(JSON.stringify(seen)).not.toContain(token);

    const zip = Buffer.from(await (await fetch(`http://127.0.0.1:${port}/api/download?deck=for-prof`, { headers: as(PROF) })).arrayBuffer());
    expect(zip.length).toBeGreaterThan(0);
    expect(zip.includes('access.json')).toBe(false);
    expect(zip.includes(token)).toBe(false);
  });

  it('never lets a redemption and an owner change undo each other', async () => {
    const port = server.cloudflarePort!;
    const put = (body: object) => fetch(`http://127.0.0.1:${server.port}/api/access?deck=private`, {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    }).then((response) => response.json() as Promise<any>);
    const first = new URL((await put({ link: 'on' })).linkUrl).searchParams.get('invite')!;
    const guests = Array.from({ length: 8 }, (_, i) => `guest${i}@x.example`);
    const [, ...redeemed] = await Promise.all([
      put({ link: 'on' }),
      ...guests.map((guest) => get(port, `/api/deck?deck=private&invite=${first}`, as(guest))),
    ]);
    expect(redeemed.every((result) => result.status === 200)).toBe(true);
    const after = (await get(server.port, '/api/access?deck=private')).body;
    for (const guest of guests) expect(after.sharedWith).toContainEqual({ login: guest, role: 'view' });

    // A reset racing more redemptions: whatever lands, the retired secret stays retired.
    const [reset] = await Promise.all([
      put({ link: 'reset' }),
      ...['a', 'b', 'c'].map((n) => get(port, `/api/deck?deck=private&invite=${first}`, as(`${n}@late.example`))),
    ]);
    const final = (await get(server.port, '/api/access?deck=private')).body;
    expect(final.linkUrl).toBe(reset.linkUrl);
    expect(final.link.token).not.toBe(first);
  });

  it('applies a Share dialog save as changes, keeping people who joined meanwhile', async () => {
    const port = server.cloudflarePort!;
    const put = (body: object) => fetch(`http://127.0.0.1:${server.port}/api/access?deck=for-prof`, {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    }).then((response) => response.json() as Promise<any>);
    const opened = (await get(server.port, '/api/access?deck=for-prof')).body;
    const token = new URL((await put({ link: 'on' })).linkUrl).searchParams.get('invite')!;
    await get(port, `/api/deck?deck=for-prof&invite=${token}`, as('joined@x.example'));
    // The dialog, opened before that, promotes the professor and adds someone.
    const saved = await put({
      sharedWith: [{ login: PROF, role: 'edit' }, { login: 'added@x.example', role: 'view' }],
      sharedWithBase: opened.sharedWith,
    });
    expect(saved.sharedWith).toEqual(expect.arrayContaining([
      { login: PROF, role: 'edit' }, { login: 'added@x.example', role: 'view' }, { login: 'joined@x.example', role: 'view' },
    ]));
    // Removing someone the dialog did list still removes them.
    const removed = await put({ sharedWith: [], sharedWithBase: saved.sharedWith.filter((s: any) => s.login === PROF) });
    expect(removed.sharedWith.map((s: any) => s.login).sort()).toEqual(['added@x.example', 'joined@x.example']);
  });

  it('never lets a stale Share dialog bring back someone another manager removed', async () => {
    const put = (body: object) => fetch(`http://127.0.0.1:${server.port}/api/access?deck=for-prof`, {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    }).then((response) => response.json() as Promise<any>);
    const BOB = 'bob@x.example';
    await put({ sharedWith: [{ login: PROF, role: 'view' }, { login: BOB, role: 'edit' }] });
    const staleBase = (await get(server.port, '/api/access?deck=for-prof')).body.sharedWith;
    // Another manager removes Bob.
    await put({ sharedWith: [{ login: PROF, role: 'view' }], sharedWithBase: staleBase });
    // The stale dialog leaves Bob's row alone and changes something else.
    const unchanged = await put({
      sharedWith: [{ login: PROF, role: 'edit' }, { login: BOB, role: 'edit' }], sharedWithBase: staleBase,
    });
    expect(unchanged.sharedWith).toEqual([{ login: PROF, role: 'edit' }]);
    // Nor does changing Bob's role in that stale dialog resurrect him.
    const demoted = await put({
      sharedWith: [{ login: PROF, role: 'edit' }, { login: BOB, role: 'view' }], sharedWithBase: staleBase,
    });
    expect(demoted.sharedWith).toEqual([{ login: PROF, role: 'edit' }]);
  });

  it('leaves no copy of the sidecar behind, and never serves a stray staging file', async () => {
    const put = (body: object) => fetch(`http://127.0.0.1:${server.port}/api/access?deck=for-prof`, {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    }).then((response) => response.json() as Promise<any>);
    for (let i = 0; i < 5; i++) await put({ link: 'reset' });
    const { readdir } = await import('node:fs/promises');
    expect((await readdir(join(rootDir, 'for-prof'))).filter((name) => name.includes('access.json'))).toEqual(['access.json']);
    // A crash between write and rename would leave a hidden file like this one.
    await writeFile(join(rootDir, 'for-prof', '.access.json.crashed.tmp'), '{"link":{"token":"leaked-secret-token-xyz"}}', 'utf8');
    const zip = Buffer.from(await (await fetch(
      `http://127.0.0.1:${server.cloudflarePort}/api/download?deck=for-prof`, { headers: as(PROF) },
    )).arrayBuffer());
    expect(zip.includes('leaked-secret-token-xyz')).toBe(false);
  });

  it('never demotes someone who already has more than the link gives', async () => {
    const port = server.cloudflarePort!;
    await writeFile(join(rootDir, 'for-prof', 'access.json'), JSON.stringify({
      owner: ADMIN, visibility: 'private', sharedWith: [{ login: PROF, role: 'edit' }],
      publicRole: 'view', link: { token: 'a'.repeat(24), role: 'view' },
    }), 'utf8');
    await get(port, `/?deck=for-prof&invite=${'a'.repeat(24)}`, as(PROF));
    expect((await get(port, '/api/access?deck=for-prof', as(PROF))).body.role).toBe('edit');
  });

  it('checks the token on the WebSocket too', async () => {
    const port = server.cloudflarePort!;
    expect(await wsResult(port, 'for-prof', as(PROF))).toEqual({ welcome: true });
    expect(await wsResult(port, 'private', as(PROF))).toEqual({ closed: 4003 });
    expect(await wsResult(port, 'for-prof', { 'tailscale-user-login': ADMIN })).toEqual({ closed: 4003 });
  });

  it('closes a live socket when the sign-in it was opened with runs out', async () => {
    // Past exp but inside the 60 s clock-skew allowance: admitted, and closed
    // when the allowance runs out, about a second from now.
    const soon = { 'cf-access-jwt-assertion': token(key, { email: PROF, exp: Math.floor(Date.now() / 1000) - 59 }) };
    expect(await wsResult(server.cloudflarePort!, 'for-prof', soon, true)).toEqual({ welcome: true, closed: 4401 });
  });

  it('offers no local-agent command through the Cloudflare door', async () => {
    expect((await get(server.cloudflarePort!, '/api/config', as(ADMIN))).body.agentPanel).toBeNull();
    expect((await get(server.port, '/api/config')).body.agentPanel).toMatchObject({ enabled: true });
  });

  it('leaves the tailscale port exactly as it was', async () => {
    expect((await get(server.port, '/api/config')).body.access).toMatchObject({ user: ADMIN, admin: true });
    expect((await get(server.port, '/api/config', { 'tailscale-user-login': PROF })).body.access)
      .toMatchObject({ user: PROF, admin: false });
    // A Cloudflare token is not an identity on the tailscale port.
    const viaServe = { ...as(ADMIN), 'tailscale-user-login': PROF, 'x-forwarded-for': '100.64.0.9' };
    expect((await get(server.port, '/api/config', viaServe)).body.access).toMatchObject({ user: PROF });
  });

  it('never lets anyone through the Cloudflare door end a hosted session', async () => {
    const hosted = await startCollabServer({
      rootDir, port: 0, host: '127.0.0.1', hostedDeckId: 'for-prof', accessControl: { admin: ADMIN },
      cloudflareAccess: {
        teamDomain: TEAM, audience: AUD, port: 0,
        verifier: createCloudflareAccessVerifier({ teamDomain: TEAM, audience: AUD }, { fetch: certsEndpoint([key]).fetch }),
      },
    });
    try {
      const end = await fetch(`http://127.0.0.1:${hosted.cloudflarePort}/api/end`, { method: 'POST', headers: as(ADMIN) });
      expect(end.status).toBe(403);
    } finally {
      await hosted.close();
    }
  });

  it('refuses to start a Cloudflare door without access control', async () => {
    await expect(startCollabServer({
      rootDir, port: 0, host: '127.0.0.1', cloudflareAccess: { teamDomain: TEAM, audience: AUD, port: 0 },
    })).rejects.toThrow(/accessControl/);
  });
});
