/**
 * Linked media: an image or video whose `src` is a web address rather than a
 * file in the deck's `assets/` folder.
 *
 * Nothing is copied, so the deck stays small, and the talk depends on the
 * network for that element. Only `https:` links are accepted: an `http:`
 * picture would be blocked as mixed content on a hosted (https) deck, and a
 * `file:` or `deck:` path would reach outside the deck folder, which every
 * asset server refuses on purpose (`resolveAsset`).
 *
 * A YouTube or Vimeo page link on a video element is shown through the
 * provider's own player, in a frame; any other link is handed to `<img>` or
 * `<video>` as is.
 */

import type { Deck, SlideElement } from './deck.js';

/** Whether `src` names linked media (an `https:` URL) rather than a deck asset. */
export function isLinkedMediaSrc(src: string | null | undefined): src is string {
  if (typeof src !== 'string' || !/^https:\/\/[^\s/?#]/i.test(src.trim())) return false;
  try {
    const url = new URL(src.trim());
    return url.protocol === 'https:' && url.hostname.includes('.');
  } catch {
    return false;
  }
}

/**
 * Every linked address the deck already shows (image and video sources and
 * video posters), in each spelling the HTML export writes them: as is, and a
 * video's with its `#t=` in-point.
 *
 * The authored-HTML sanitizers keep an external `src`/`poster` only when it
 * is on this list. That is what lets a deck's own linked media survive the
 * agent round trip (export to HTML, edit, compile back) while markup from
 * anywhere else -- an import, a page an agent wrote, an attribute copied to
 * look like a deck object -- still cannot make the app fetch a new address.
 * Adding linked media is done in the editor (Link…), never through HTML.
 */
export function deckLinkedMedia(deck: Deck): Set<string> {
  const allowed = new Set<string>();
  const collect = (elements: readonly SlideElement[]) => {
    for (const el of elements) {
      if (el.type !== 'image' && el.type !== 'video') continue;
      if (isLinkedMediaSrc(el.src)) {
        allowed.add(el.src);
        if (el.type === 'video' && el.start > 0) allowed.add(`${el.src}#t=${el.start}`);
      }
      if (el.type === 'video' && isLinkedMediaSrc(el.poster)) allowed.add(el.poster);
    }
  };
  for (const slide of deck.slides) collect(slide.elements);
  for (const master of Object.values(deck.layoutMasters ?? {})) collect(master.elements);
  return allowed;
}

/**
 * Wrap a deck-asset resolver so linked media passes through untouched. Every
 * surface that draws slides resolves `src` through one of these.
 */
export function withLinkedMedia(resolve: (src: string) => string): (src: string) => string {
  return (src) => (isLinkedMediaSrc(src) ? src : resolve(src));
}

export interface VideoEmbed {
  provider: 'youtube' | 'vimeo';
  id: string;
  /** Vimeo's privacy hash for unlisted videos (`vimeo.com/<id>/<hash>`). */
  hash?: string;
}

/** The provider player behind a YouTube or Vimeo link, or null for any other URL. */
export function videoEmbedFor(src: string | null | undefined): VideoEmbed | null {
  if (!isLinkedMediaSrc(src)) return null;
  let url: URL;
  try {
    url = new URL(src.trim());
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase().replace(/^(?:www\.|m\.)/, '');
  const path = url.pathname.split('/').filter(Boolean);
  // Route ids, not video ids: a playlist or a live channel has no single
  // clip to embed, trim or link to from a PDF.
  const youtubeId = (value: string | null | undefined): VideoEmbed | null =>
    value && /^[\w-]{6,20}$/.test(value) && value !== 'videoseries' ? { provider: 'youtube', id: value } : null;

  if (host === 'youtu.be') return youtubeId(path[0]);
  if (host === 'youtube.com' || host === 'youtube-nocookie.com' || host === 'music.youtube.com') {
    if (path[0] === 'watch') return youtubeId(url.searchParams.get('v'));
    if (['embed', 'shorts', 'live', 'v'].includes(path[0] ?? '')) return youtubeId(path[1]);
    return null;
  }
  if (host === 'vimeo.com' || host === 'player.vimeo.com') {
    // vimeo.com/<id>, vimeo.com/<id>/<hash>, player.vimeo.com/video/<id>?h=<hash>,
    // channels/<name>/<id>, groups/<name>/videos/<id>, and showcase/<sid>/video/<id>
    // -- where the first number is the showcase's, not the video's.
    const marker = path.findIndex((segment) => segment === 'video' || segment === 'videos');
    const from = marker >= 0 ? marker + 1 : path[0] === 'showcase' || path[0] === 'album' ? path.length : 0;
    const index = path.findIndex((segment, i) => i >= from && /^\d{5,}$/.test(segment));
    if (index < 0) return null;
    const next = path[index + 1];
    const hash = url.searchParams.get('h') ?? (next && /^[0-9a-f]{6,}$/i.test(next) ? next : undefined);
    return { provider: 'vimeo', id: path[index], ...(hash ? { hash } : {}) };
  }
  return null;
}

/**
 * The in-point a pasted provider link asks for, in seconds: YouTube's `t=` or
 * `start=` (`90`, `90s`, `1m30s`, `1h2m3s`) and Vimeo's `#t=`. Zero when the
 * link names none. Used once, when the link is inserted; after that the
 * element's own `start` (the inspector's Start) is what plays.
 */
export function linkedMediaStart(src: string): number {
  if (!videoEmbedFor(src)) return 0;
  let url: URL;
  try {
    url = new URL(src.trim());
  } catch {
    return 0;
  }
  const hash = new URLSearchParams(url.hash.replace(/^#/, ''));
  const raw = url.searchParams.get('t') ?? url.searchParams.get('start') ?? hash.get('t') ?? '';
  const match = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s?)?$/i.exec(raw.trim());
  if (!raw || !match) return 0;
  const [, h = '0', m = '0', sec = '0'] = match;
  return Number(h) * 3600 + Number(m) * 60 + Number(sec);
}

/** Playback fields of a video element that the provider players understand. */
export interface EmbedPlayback {
  start: number;
  end: number | null;
  loop: boolean;
  muted: boolean;
}

/**
 * The provider player URL for an embedded video, carrying the element's trim
 * and playback flags. YouTube is loaded from its no-cookie domain.
 *
 * An embed never starts by itself and always shows the provider's controls:
 * the presenter presses play. The frame exists before build state decides
 * whether its element is shown, so an autoplaying player would be heard
 * before it is seen. Each player's message API is switched on so the deck
 * can pause it (`embedPauseMessage`) when the element is hidden or the
 * screen blanked.
 *
 * Vimeo's player URL takes an in-point but no out-point, so a Vimeo embed
 * plays past `end`; the inspector says so where End is set.
 */
export function embedPlayerUrl(embed: VideoEmbed, playback: EmbedPlayback): string {
  const start = Math.max(0, Math.floor(playback.start));
  const end = playback.end === null ? null : Math.max(start + 1, Math.ceil(playback.end));
  if (embed.provider === 'youtube') {
    const params = new URLSearchParams({ rel: '0', modestbranding: '1', playsinline: '1', enablejsapi: '1' });
    if (start > 0) params.set('start', String(start));
    if (end !== null) params.set('end', String(end));
    if (playback.muted) params.set('mute', '1');
    // YouTube loops only a playlist, so a looping clip is a playlist of itself.
    if (playback.loop) {
      params.set('loop', '1');
      params.set('playlist', embed.id);
    }
    return `https://www.youtube-nocookie.com/embed/${encodeURIComponent(embed.id)}?${params}`;
  }
  const params = new URLSearchParams({ dnt: '1', title: '0', byline: '0', portrait: '0', api: '1' });
  if (embed.hash) params.set('h', embed.hash);
  if (playback.muted) params.set('muted', '1');
  if (playback.loop) params.set('loop', '1');
  const fragment = start > 0 ? `#t=${start}s` : '';
  return `https://player.vimeo.com/video/${encodeURIComponent(embed.id)}?${params}${fragment}`;
}

/** The message that pauses a provider player, and the origin to send it to. */
export function embedPauseMessage(provider: VideoEmbed['provider']): { message: string; origin: string } {
  return provider === 'youtube'
    ? { message: JSON.stringify({ event: 'command', func: 'pauseVideo', args: [] }), origin: 'https://www.youtube-nocookie.com' }
    : { message: JSON.stringify({ method: 'pause' }), origin: 'https://player.vimeo.com' };
}

/**
 * A still for an embedded video, shown wherever the player cannot run (the
 * editor canvas, thumbnails, PDF). YouTube publishes one at a fixed address;
 * Vimeo needs an API call, so a Vimeo embed gets the element's own poster or
 * a labelled placeholder instead.
 */
export function embedThumbnailUrl(embed: VideoEmbed): string | null {
  return embed.provider === 'youtube'
    ? `https://i.ytimg.com/vi/${encodeURIComponent(embed.id)}/hqdefault.jpg`
    : null;
}

/**
 * Where a click on this video should go when it cannot play in place (a PDF
 * page): the address the author linked, with the in-point for providers that
 * take one. Null for a video stored in the deck.
 */
export function linkedVideoWatchUrl(src: string, start = 0): string | null {
  if (!isLinkedMediaSrc(src)) return null;
  const embed = videoEmbedFor(src);
  const at = Math.max(0, Math.floor(start));
  if (embed?.provider === 'youtube') {
    return `https://www.youtube.com/watch?v=${encodeURIComponent(embed.id)}${at > 0 ? `&t=${at}s` : ''}`;
  }
  if (embed?.provider === 'vimeo') {
    return `https://vimeo.com/${encodeURIComponent(embed.id)}${embed.hash ? `/${encodeURIComponent(embed.hash)}` : ''}${at > 0 ? `#t=${at}s` : ''}`;
  }
  return src.trim();
}

/** What a pasted link should become, judged from the address alone. */
export function linkedMediaKind(src: string): 'image' | 'video' | null {
  if (!isLinkedMediaSrc(src)) return null;
  if (videoEmbedFor(src)) return 'video';
  let pathname: string;
  try {
    pathname = new URL(src.trim()).pathname;
  } catch {
    return null;
  }
  if (/\.(?:mp4|m4v|mov|webm|ogv)$/i.test(pathname)) return 'video';
  if (/\.(?:png|jpe?g|gif|webp|avif|svg|bmp)$/i.test(pathname)) return 'image';
  return null;
}

/**
 * The origins a slide window must let frames, pictures and video load from for
 * linked media to show. Kept here so every window's policy agrees (and a test
 * can check them).
 */
export const LINKED_MEDIA_FRAME_ORIGINS = ['https://www.youtube-nocookie.com', 'https://player.vimeo.com'] as const;
