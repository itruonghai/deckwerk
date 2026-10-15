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
      .toEqual({ login: PROF, name: PROF });
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
