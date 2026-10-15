/**
 * A third door, for "anyone with the link can view — no sign-in": a
 * loopback listener (`--view-port`) behind its own public hostname on the
 * Cloudflare Tunnel, with no Cloudflare Access in front of it, so viewers
 * need no account and take no Access seat.
 *
 * Nobody is anybody here. The only thing that opens a deck on this listener
 * is that deck's link secret, and only while its owner has the link set to
 * "anyone" (see DeckAccess.link and deckRoleFor in accessControl.ts). The
 * secret arrives once in the address (`?view=`), and the server keeps it in
 * an HttpOnly cookie for the deck's other requests: its assets, the
 * WebSocket, the presentation page. What it grants is view-only, of that one
 * deck, and it stops working the moment the owner turns the link off or
 * resets it — including for a viewer who is watching right then.
 *
 * As on the Cloudflare door, which listener accepted the connection decides
 * the identity rule: Tailscale headers and Cloudflare tokens are never read
 * here, and loopback proves nothing (every request comes from the tunnel
 * daemon on this machine).
 */

import { createHash } from 'node:crypto';
import type { Socket } from 'node:net';
import type { IncomingMessage } from 'node:http';
// Types only: accessControl.ts imports this module for resolveIdentity.
import type { Identity } from './accessControl.js';

/** The login every link viewer shares: no "@", so never anyone's account. */
export const LINK_VIEWER_LOGIN = 'link-viewer';
const COOKIE_PREFIX = 'deckwerk_view_';
/** How long a viewer's browser keeps a link it has opened. */
const COOKIE_MAX_AGE_S = 30 * 24 * 60 * 60;
/** What a link secret looks like (newLinkToken: 18 random bytes, base64url). */
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{20,64}$/;

const viewSockets = new WeakSet<Socket>();
const viewIdentities = new WeakMap<IncomingMessage, Identity>();

export function admitViewSocket(socket: Socket): void {
  viewSockets.add(socket);
}

export function isViewLinkRequest(request: IncomingMessage): boolean {
  return viewSockets.has(request.socket as Socket);
}

/** The link viewer this request is, or null when it carries no link secret at all. */
export function viewIdentityOf(request: IncomingMessage): Identity | null {
  return viewIdentities.get(request) ?? null;
}

/** Every link secret this browser holds: one cookie per deck it has opened. */
function cookieTokens(request: IncomingMessage): string[] {
  const header = request.headers.cookie ?? '';
  const tokens: string[] = [];
  for (const part of header.split(';')) {
    const at = part.indexOf('=');
    if (at < 0) continue;
    const name = part.slice(0, at).trim();
    const value = part.slice(at + 1).trim();
    if (name.startsWith(COOKIE_PREFIX) && TOKEN_SHAPE.test(value)) tokens.push(value);
  }
  return tokens.slice(0, 50);
}

function cookieNameFor(deckId: string): string {
  return `${COOKIE_PREFIX}${createHash('sha256').update(deckId).digest('hex').slice(0, 16)}`;
}

/**
 * Read the link secrets this request carries and remember them as its
 * identity. Whether any of them opens the deck asked for is decided per deck
 * by deckRoleFor. Returns the Set-Cookie value to send when the address
 * brought a secret, so the deck's later requests carry it too.
 */
export function admitViewRequest(request: IncomingMessage, url: URL): { setCookie: string | null } {
  const fromAddress = url.searchParams.get('view');
  const deckId = url.searchParams.get('deck');
  const tokens = cookieTokens(request);
  let setCookie: string | null = null;
  if (fromAddress && TOKEN_SHAPE.test(fromAddress)) {
    tokens.unshift(fromAddress);
    if (deckId) {
      setCookie = `${cookieNameFor(deckId)}=${fromAddress}; Path=/; Max-Age=${COOKIE_MAX_AGE_S}; `
        + 'HttpOnly; Secure; SameSite=Lax';
    }
  }
  if (tokens.length > 0) {
    viewIdentities.set(request, {
      login: LINK_VIEWER_LOGIN,
      name: 'Viewer',
      external: true,
      linkTokens: [...new Set(tokens)],
    });
  }
  return { setCookie };
}
