import { session } from 'electron';
import { LINKED_MEDIA_FRAME_ORIGINS } from '@shared/linkedMedia.js';

/**
 * The address the app's YouTube and Vimeo players identify themselves with.
 *
 * YouTube refuses to play an embed whose request carries no Referer (player
 * error 153, "video player configuration error"), and Vimeo's domain-limited
 * privacy reads the same header. A packaged app loads its windows from
 * `file://`, which sends no Referer at all, so every embed failed there while
 * working under the dev server. The project's own site is the honest answer
 * to "which application is embedding this".
 */
export const EMBED_REFERRER = 'https://deckwerk.org/';

/** Give provider player requests a Referer when the page could not send one. */
export function installEmbedReferrer(): void {
  const urls = LINKED_MEDIA_FRAME_ORIGINS.map((origin) => `${origin}/*`);
  session.defaultSession.webRequest.onBeforeSendHeaders({ urls }, (details, callback) => {
    const headers = details.requestHeaders;
    if (!headers.Referer && !headers.referer) headers.Referer = EMBED_REFERRER;
    callback({ requestHeaders: headers });
  });
}
