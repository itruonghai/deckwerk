import { isLinkedMediaSrc, videoEmbedFor } from '@shared/linkedMedia.js';

/**
 * The still a linked provider video is given as its `poster`, for previews
 * and PDF pages where the player cannot run.
 *
 * YouTube needs none: its thumbnail address follows from the video id
 * (`embedThumbnailUrl`). Vimeo publishes no fixed address, but its public
 * oEmbed endpoint answers cross-origin with one. Without it the embed shows a
 * labelled placeholder, which still works, so any failure here is quiet.
 */
export async function linkedVideoPoster(src: string, signal: AbortSignal): Promise<string | null> {
  if (videoEmbedFor(src)?.provider !== 'vimeo') return null;
  try {
    const response = await fetch(`https://vimeo.com/api/oembed.json?url=${encodeURIComponent(src)}&width=1280`, { signal });
    if (!response.ok) return null;
    const body = await response.json() as { thumbnail_url?: unknown };
    return typeof body.thumbnail_url === 'string' && isLinkedMediaSrc(body.thumbnail_url) ? body.thumbnail_url : null;
  } catch {
    return null;
  }
}

/**
 * A signal that fires when `cancelled` does or after `ms`, whichever is
 * first. `AbortSignal.any` and `AbortSignal.timeout` are recent, and the
 * browser collab client runs in whatever browser a collaborator has.
 */
export function probeDeadline(cancelled: AbortSignal, ms: number): AbortSignal {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  const stop = (): void => {
    clearTimeout(timer);
    controller.abort();
  };
  if (cancelled.aborted) stop();
  else cancelled.addEventListener('abort', stop, { once: true });
  controller.signal.addEventListener('abort', () => clearTimeout(timer), { once: true });
  return controller.signal;
}
