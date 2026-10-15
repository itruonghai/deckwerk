/**
 * Opt-in access control for the collab server (`--access <adminLogin>`).
 *
 * Identity comes from Tailscale, not from accounts: the server binds loopback
 * and sits behind `tailscale serve`, which terminates TLS on the tailnet and
 * stamps every proxied request with `Tailscale-User-Login` /
 * `Tailscale-User-Name` headers. Those headers are trusted ONLY when the
 * socket peer is loopback — off-loopback they could be forged by whoever set
 * them, so such connections are rejected outright. A bare loopback request
 * without the headers is someone at the machine itself (SSH, curl, the
 * launchd owner) and counts as the admin.
 *
 * A second door, for people off the tailnet, is a Cloudflare Tunnel behind
 * Cloudflare Access on a listener of its own (cloudflareAccess.ts). On that
 * listener none of the above applies: identity is the verified Access token
 * or nobody.
 *
 * Per-deck permissions live in an `access.json` sidecar next to `deck.json`.
 * It is deliberately not part of the deck document: deck.json rides the
 * collab diff/sync path, and a permissions file must never be editable
 * through a deck transaction. A deck without the sidecar is public and
 * admin-owned, so enabling the flag on an existing decks directory changes
 * nothing until somebody shares or restricts a deck.
 *
 * Every grant carries a role — `edit` or `view`. Roles only ever add up: a
 * person's role is the most permissive of what their explicit share gives
 * them and what the deck's public setting gives everyone, so sharing a public
 * deck for editing works, and listing somebody as a viewer never takes away
 * access they already had from the deck being public.
 *
 * Folders are ordinary directories under the decks root that hold decks (and
 * other folders) instead of a `deck.json`. They carry their own one-line
 * `folder.json` sidecar naming the creator, because folder visibility is
 * otherwise entirely derived: see `folderVisibleTo`.
 */

import { randomUUID, timingSafeEqual } from 'node:crypto';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { IncomingMessage } from 'node:http';
import { cloudflareIdentityOf, isCloudflareRequest } from './cloudflareAccess.js';
import { isViewLinkRequest, viewIdentityOf } from './viewLinks.js';

export interface AccessControlConfig {
  /** Tailnet login of the administrator; sees and manages every deck. */
  admin: string;
}

export interface Identity {
  /** Stable tailnet login (e.g. "alice@github") — the authorization subject. */
  login: string;
  /** Human display name for presence and comments. */
  name: string;
  /**
   * Signed in through the Cloudflare door rather than the tailnet: a guest
   * from the internet. Guests get what is shared with them by name or by
   * the deck's link, never what "public" gives everyone on the tailnet.
   */
  external?: boolean;
  /**
   * A link viewer (viewLinks.ts): nobody in particular, holding these deck
   * link secrets. Such an identity sees exactly the decks whose link is set
   * to "anyone" with one of these secrets, view-only, and nothing else.
   */
  linkTokens?: string[];
}

/**
 * Who a permission question is about: a bare login (a tailnet person, as
 * every caller before the Cloudflare door), or a full identity.
 */
export type Subject = string | Identity;

function subjectLogin(who: Subject): string {
  return typeof who === 'string' ? who : who.login;
}

/** A guest, unless they are the admin (whose email is theirs on either door). */
export function isGuest(who: Subject, config: AccessControlConfig): boolean {
  return typeof who !== 'string' && who.external === true && who.login !== normalizeLogin(config.admin);
}

/** What a grant lets somebody do. `view` never writes: not a byte. */
export type AccessRole = 'edit' | 'view';

/** One person's grant on a deck. */
export interface DeckShare {
  login: string;
  role: AccessRole;
}

export interface DeckAccess {
  owner: string;
  visibility: 'public' | 'private';
  /**
   * Named grants. Sidecars written before roles existed hold bare logins;
   * those read back as `edit`, which is what sharing meant then.
   */
  sharedWith: DeckShare[];
  /** What `visibility: "public"` grants everyone else on the tailnet. */
  publicRole: AccessRole;
  /**
   * "Anyone with the link can view". Null when link sharing is off.
   * - `anyone: false`: whoever opens the deck with this secret (`?invite=`)
   *   after signing in is added to `sharedWith` as a viewer, so they show
   *   up in Share… and can be removed there.
   * - `anyone: true`: also opens the deck, view-only, without signing in,
   *   on the view-link door (`?view=`, viewLinks.ts).
   */
  link: { token: string; role: 'view'; anyone: boolean } | null;
}

/** A deck's owner (or the admin) outranks both share roles. */
export type DeckRole = 'owner' | AccessRole;

export const ACCESS_FILE = 'access.json';
export const FOLDER_FILE = 'folder.json';

/** Compare two secrets without the time it takes saying how much of them matched. */
export function sameSecret(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function normalizeLogin(value: string): string {
  return value.trim().toLowerCase();
}

function isLoopback(request: IncomingMessage): boolean {
  const remote = request.socket.remoteAddress ?? '';
  return remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1';
}

function headerValue(request: IncomingMessage, name: string): string {
  const raw = request.headers[name];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return (value ?? '').trim();
}

/**
 * Resolve who is making this request, or null if nobody trustworthy is.
 * Null means "reject": with access control on, every byte the server emits
 * is tied to a tailnet identity.
 */
export function resolveIdentity(
  request: IncomingMessage,
  config: AccessControlConfig,
): Identity | null {
  // The tunnel daemon connects over loopback too, and passes through whatever
  // headers the visitor sent: only the token Cloudflare signed says who it is.
  if (isCloudflareRequest(request)) return cloudflareIdentityOf(request);
  // Likewise the view-link door: link secrets, or nobody.
  if (isViewLinkRequest(request)) return viewIdentityOf(request);
  if (!isLoopback(request)) return null;
  const login = headerValue(request, 'tailscale-user-login');
  if (login) {
    return {
      login: normalizeLogin(login),
      name: headerValue(request, 'tailscale-user-name') || login,
    };
  }
  // Serve stamps every request it proxies with X-Forwarded-For, but only
  // requests from a tailnet *user* get the identity headers: traffic from a
  // tagged node, or from the public internet via `tailscale funnel`, arrives
  // on loopback with the forwarding headers and no login. That is an
  // anonymous stranger, not the machine owner — refuse rather than promote.
  if (headerValue(request, 'x-forwarded-for')) return null;
  // Loopback without any proxy headers: a shell on the server machine itself.
  return { login: normalizeLogin(config.admin), name: config.admin };
}

function asRole(value: unknown, fallback: AccessRole): AccessRole {
  return value === 'view' || value === 'edit' ? value : fallback;
}

/**
 * Normalize a sidecar's share list. Entries are `{ login, role }`; a bare
 * string is a pre-roles sidecar and means edit. One entry per login wins —
 * the most permissive, so a duplicated person is never quietly demoted.
 */
export function normalizeShares(value: unknown): DeckShare[] {
  if (!Array.isArray(value)) return [];
  const byLogin = new Map<string, DeckShare>();
  for (const entry of value) {
    const raw = typeof entry === 'string' ? { login: entry, role: 'edit' } : entry;
    if (!raw || typeof raw !== 'object') continue;
    const candidate = raw as { login?: unknown; role?: unknown };
    if (typeof candidate.login !== 'string' || !candidate.login.trim()) continue;
    const login = normalizeLogin(candidate.login);
    const role = asRole(candidate.role, 'edit');
    const existing = byLogin.get(login);
    if (existing?.role === 'edit') continue;
    byLogin.set(login, { login, role });
  }
  return [...byLogin.values()];
}

/** Read a deck's sidecar; a missing or unreadable file is public/admin-owned. */
export async function readDeckAccess(deckDir: string, config: AccessControlConfig): Promise<DeckAccess> {
  const fallback: DeckAccess = {
    owner: normalizeLogin(config.admin),
    visibility: 'public',
    sharedWith: [],
    // Public used to mean "everyone can edit it", and a sidecar-less deck is
    // exactly the pre-roles case, so that is what it keeps meaning.
    publicRole: 'edit',
    link: null,
  };
  let raw: string;
  try {
    raw = await readFile(join(deckDir, ACCESS_FILE), 'utf8');
  } catch {
    return fallback;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<DeckAccess>;
    return {
      owner: typeof parsed.owner === 'string' && parsed.owner.trim()
        ? normalizeLogin(parsed.owner)
        : fallback.owner,
      visibility: parsed.visibility === 'private' ? 'private' : 'public',
      sharedWith: normalizeShares(parsed.sharedWith),
      publicRole: asRole(parsed.publicRole, 'edit'),
      link: readLink(parsed.link),
    };
  } catch {
    // A corrupt sidecar must not lock the admin out of the deck; treating it
    // as absent (public) is the recoverable failure mode.
    return fallback;
  }
}

function readLink(value: unknown): DeckAccess['link'] {
  if (!value || typeof value !== 'object') return null;
  const token = (value as { token?: unknown }).token;
  // Short or odd tokens would be guessable; treat them as no link at all.
  return typeof token === 'string' && /^[A-Za-z0-9_-]{20,}$/.test(token)
    ? { token, role: 'view', anyone: (value as { anyone?: unknown }).anyone === true }
    : null;
}

export async function writeDeckAccess(deckDir: string, access: DeckAccess): Promise<void> {
  // Whole or not at all: a reader never sees half a sidecar, which would
  // read as "corrupt", which reads as public.
  // The staging copy is a dotfile, which nothing serves, downloads, mirrors
  // or imports: if a crash leaves it behind, the secret in it stays put.
  const target = join(deckDir, ACCESS_FILE);
  const staging = join(deckDir, `.${ACCESS_FILE}.${randomUUID()}.tmp`);
  try {
    await writeFile(staging, `${JSON.stringify(access, null, 2)}\n`, 'utf8');
    await rename(staging, target);
  } catch (error) {
    await rm(staging, { force: true }).catch(() => undefined);
    throw error;
  }
}

const accessLocks = new Map<string, Promise<unknown>>();

/**
 * Run a read-change-write of one deck's sidecar after every earlier one for
 * that deck has finished. Two of them interleaved — the owner resetting the
 * link while somebody opens it — would each write back what the other had
 * just changed away.
 */
export function withDeckAccessLock<T>(deckDir: string, task: () => Promise<T>): Promise<T> {
  const previous = accessLocks.get(deckDir) ?? Promise.resolve();
  const run = previous.catch(() => undefined).then(task);
  const settled = run.catch(() => undefined);
  accessLocks.set(deckDir, settled);
  void settled.then(() => {
    if (accessLocks.get(deckDir) === settled) accessLocks.delete(deckDir);
  });
  return run;
}

/**
 * This person's role on this deck, or null if they may not open it at all.
 * Grants add up rather than override: the most permissive of the explicit
 * share and the public setting wins.
 */
export function deckRoleFor(
  who: Subject,
  access: DeckAccess,
  config: AccessControlConfig,
): DeckRole | null {
  // A link viewer is only ever what a matching "anyone" link gives.
  if (typeof who !== 'string' && who.linkTokens) {
    const link = access.link;
    return link?.anyone && who.linkTokens.some((token) => sameSecret(token, link.token)) ? 'view' : null;
  }
  const login = subjectLogin(who);
  if (login === normalizeLogin(config.admin) || access.owner === login) return 'owner';
  const granted: AccessRole[] = [];
  const share = access.sharedWith.find((entry) => entry.login === login);
  if (share) granted.push(share.role);
  // "Public" is everyone on the tailnet. A guest from the internet is not.
  if (access.visibility === 'public' && !isGuest(who, config)) granted.push(access.publicRole);
  if (granted.length === 0) return null;
  return granted.includes('edit') ? 'edit' : 'view';
}

export function canAccessDeck(who: Subject, access: DeckAccess, config: AccessControlConfig): boolean {
  return deckRoleFor(who, access, config) !== null;
}

/** Whether this person may change the deck — transactions, uploads, the agent. */
export function canEditDeck(who: Subject, access: DeckAccess, config: AccessControlConfig): boolean {
  const role = deckRoleFor(who, access, config);
  return role === 'owner' || role === 'edit';
}

/**
 * Whether a role may comment. Comments live inside deck.json, so leaving one
 * is an edit: viewers may not. The deck chat is not part of the document, but
 * it follows this same rule, so "may I say something about this deck" has
 * one answer whichever surface asks.
 */
export function roleMayComment(role: DeckRole | null): boolean {
  return role === 'owner' || role === 'edit';
}

export function canManageDeck(login: string, access: DeckAccess, config: AccessControlConfig): boolean {
  return login === normalizeLogin(config.admin) || access.owner === login;
}

/**
 * Who created a folder. Like a deck's sidecar, a missing one means the admin:
 * folders that predate the feature (or were made in Finder) belong to the
 * machine owner.
 */
export async function readFolderOwner(dir: string, config: AccessControlConfig): Promise<string> {
  try {
    const parsed = JSON.parse(await readFile(join(dir, FOLDER_FILE), 'utf8')) as { owner?: unknown };
    if (typeof parsed.owner === 'string' && parsed.owner.trim()) return normalizeLogin(parsed.owner);
  } catch {
    // Missing or corrupt: fall through to the admin, same as a deck sidecar.
  }
  return normalizeLogin(config.admin);
}

export async function writeFolderOwner(dir: string, owner: string): Promise<void> {
  await writeFile(
    join(dir, FOLDER_FILE),
    `${JSON.stringify({ owner: normalizeLogin(owner) }, null, 2)}\n`,
    'utf8',
  );
}

/**
 * Whether a folder exists at all, as far as this person is concerned.
 *
 * A folder is a container, not a thing that is itself shared: it is visible
 * exactly when it holds at least one deck this person may open, at any depth.
 * Someone who has been shared nothing inside it never learns it exists — not
 * its name, not that the people above them keep work there. The two
 * exceptions are the people for whom an invisible folder would be a bug
 * rather than a secret: the admin, and the person who just created it (who
 * still has to be able to put the first deck in).
 */
export function folderVisibleTo(
  login: string,
  folder: { owner: string; accessibleDecks: number },
  config: AccessControlConfig,
): boolean {
  if (login === normalizeLogin(config.admin)) return true;
  if (folder.owner === login) return true;
  return folder.accessibleDecks > 0;
}

export interface KnownUser {
  login: string;
  name: string;
  lastSeen: string;
}

/**
 * The server's people directory: everyone whose tailnet identity it has ever
 * seen, persisted as users.json in the decks root. It exists so the share
 * dialog can autocomplete logins and show human names — it grants nothing;
 * authorization is always the live identity plus the deck sidecars.
 */
export class UserDirectory {
  private users = new Map<string, KnownUser>();
  private loaded = false;
  private writing: Promise<void> = Promise.resolve();
  private pending = new Set<Promise<void>>();

  constructor(private readonly file: string) {}

  private async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const raw = JSON.parse(await readFile(this.file, 'utf8')) as unknown;
      if (Array.isArray(raw)) {
        for (const entry of raw) {
          const user = entry as Partial<KnownUser>;
          if (typeof user.login !== 'string' || !user.login) continue;
          this.users.set(normalizeLogin(user.login), {
            login: normalizeLogin(user.login),
            name: typeof user.name === 'string' && user.name ? user.name : user.login,
            lastSeen: typeof user.lastSeen === 'string' ? user.lastSeen : new Date(0).toISOString(),
          });
        }
      }
    } catch {
      // Missing or corrupt directory: start empty; it repopulates on sight.
    }
  }

  /** Record that this identity was seen just now; persists only on change. */
  note(identity: Identity): Promise<void> {
    // Register before the first await in noteNow. Request handlers deliberately
    // fire-and-forget this work, so shutdown can otherwise call flush while a
    // note is still loading users.json but has not joined `writing` yet.
    const task = this.noteNow(identity);
    this.pending.add(task);
    void task.finally(() => this.pending.delete(task));
    return task;
  }

  private async noteNow(identity: Identity): Promise<void> {
    await this.load();
    const existing = this.users.get(identity.login);
    const now = new Date();
    // A request without the display-name header falls back to the login; that
    // fallback must never overwrite a real name learned earlier.
    const name = identity.name === identity.login && existing ? existing.name : identity.name;
    // lastSeen is deliberately coarse (an hour) so routine traffic doesn't
    // rewrite the file on every request.
    const stale = !existing
      || existing.name !== name
      || now.getTime() - new Date(existing.lastSeen).getTime() > 60 * 60 * 1000;
    if (!stale) return;
    this.users.set(identity.login, {
      login: identity.login,
      name,
      lastSeen: now.toISOString(),
    });
    const snapshot = this.list();
    // Written beside and renamed into place: a reader — the next server
    // start, or a test looking at the file — never sees a half-written
    // directory. writeFile alone truncates first and fills in after.
    this.writing = this.writing.then(async () => {
      const partial = `${this.file}.${process.pid}.tmp`;
      await writeFile(partial, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
      await rename(partial, this.file);
    }).catch(() => {});
    await this.writing;
  }

  list(): KnownUser[] {
    return [...this.users.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * Resolve once every write so far is on disk. `note` is fire-and-forget on
   * the request path, so shutdown waits here rather than leaving a write to
   * land in a directory the caller is already deleting.
   */
  async flush(): Promise<void> {
    await Promise.all([...this.pending]);
    await this.writing;
  }

  async all(): Promise<KnownUser[]> {
    await this.load();
    return this.list();
  }
}
