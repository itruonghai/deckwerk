import { NEW_MEDIA_FIT } from '@shared/deck.js';
import { makeId } from '@shared/geometry.js';
import { isLinkedMediaSrc, linkedMediaKind, linkedMediaStart, videoEmbedFor } from '@shared/linkedMedia.js';
import { barIconButton, LINK_ICON } from './shellWiring.js';
import { linkedVideoPoster, probeDeadline } from './linkedMediaPoster.js';
import type { EditorStore } from './store.js';

/**
 * Insert › Link…: put an image or video on the slide by its web address,
 * without copying it into the deck (see `@shared/linkedMedia`). A YouTube or
 * Vimeo page link becomes that provider's player; a direct link to a picture
 * or a video file is shown as is.
 *
 * The dialog uses the shared workflow-dialog chrome (as confirmDialog.ts),
 * and the shell's delayed status-bar progress while the link is opened.
 * Before inserting, the address is loaded once in the page, both to learn its
 * natural size (so the box starts at the right shape) and to refuse a link
 * that does not open as an image or video, rather than leaving a broken box.
 */

/** One budget for the whole probe, however many ways the address is tried. */
const PROBE_TIMEOUT_MS = 10_000;
/** The provider players letterbox anything into 16:9. */
const EMBED_SIZE = { width: 1600, height: 900 };

interface ProbedLink {
  kind: 'image' | 'video';
  width: number;
  height: number;
  /** A still to show where the player cannot run (Vimeo's, from its oEmbed). */
  poster?: string | null;
}

/** The shell's busy indicator (shared status-bar progress), when it has one. */
export type RunOperation = <T>(message: string, action: () => Promise<T>) => Promise<T>;

/** The toolbar's Link button, beside Text, Shape and Table. */
export function createLinkMediaButton(store: EditorStore, runOperation?: RunOperation): HTMLButtonElement {
  const button = barIconButton('Link', LINK_ICON, () => void showLinkMediaDialog(store, runOperation));
  button.title = 'Insert an image or video from a web link (YouTube, Vimeo or a direct file link)';
  return button;
}

export function showLinkMediaDialog(store: EditorStore, runOperation?: RunOperation): Promise<boolean> {
  return new Promise((resolve) => {
    const returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const overlay = document.createElement('div');
    overlay.className = 'workflow-overlay';

    const dialog = document.createElement('section');
    dialog.className = 'workflow-dialog confirm-dialog link-media-dialog';
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-labelledby', 'link-media-title');

    const title = document.createElement('h2');
    title.id = 'link-media-title';
    title.textContent = 'Insert from link';
    const description = document.createElement('p');
    description.className = 'confirm-dialog-description';
    description.textContent = 'Paste a YouTube or Vimeo link, or a direct https link to an image or video file. '
      + 'Nothing is copied into the deck; it loads from the web when shown.';

    const input = document.createElement('input');
    input.type = 'url';
    input.className = 'link-media-input';
    input.placeholder = 'https://www.youtube.com/watch?v=…';
    input.spellcheck = false;
    input.setAttribute('aria-label', 'Media link');

    const status = document.createElement('p');
    status.className = 'link-media-status link-media-error';
    status.setAttribute('role', 'alert');
    status.hidden = true;

    const actions = document.createElement('div');
    actions.className = 'workflow-actions';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.textContent = 'Cancel';
    const confirm = document.createElement('button');
    confirm.type = 'button';
    confirm.className = 'primary';
    confirm.textContent = 'Insert';
    actions.append(cancel, confirm);

    // Cancelling, Escape or the backdrop abandon a probe in flight: its media
    // requests are dropped, and a late answer inserts nothing.
    const abort = new AbortController();
    let finished = false;
    let busy = false;
    const finish = (inserted: boolean): void => {
      if (finished) return;
      finished = true;
      abort.abort();
      overlay.remove();
      if (returnFocus?.isConnected) returnFocus.focus();
      resolve(inserted);
    };
    const showError = (text: string): void => {
      status.hidden = false;
      status.textContent = text;
    };
    const setBusy = (next: boolean): void => {
      busy = next;
      confirm.disabled = next;
      input.disabled = next;
      // A disabled control drops focus to the page, where keys would reach
      // the editor behind the dialog; Cancel stays reachable instead.
      if (next) cancel.focus();
      else input.focus();
    };
    const submit = async (): Promise<void> => {
      if (busy) return;
      const src = input.value.trim();
      if (!isLinkedMediaSrc(src)) {
        showError('Enter a link that starts with https://');
        input.focus();
        return;
      }
      status.hidden = true;
      setBusy(true);
      const probe = () => probeLink(src, abort.signal);
      const probed = await (runOperation ? runOperation(`Opening ${linkLabel(src)}`, probe) : probe());
      if (finished) return;
      setBusy(false);
      if (!probed) {
        showError('That link did not open as an image or a video. Check that it points at the file itself, '
          + 'or at a YouTube or Vimeo video page.');
        return;
      }
      insertLinkedMedia(store, src, probed);
      finish(true);
    };

    cancel.addEventListener('click', () => finish(false));
    confirm.addEventListener('click', () => void submit());
    overlay.addEventListener('pointerdown', (event) => {
      if (event.target === overlay) finish(false);
    });
    overlay.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        finish(false);
        return;
      }
      if (event.key === 'Enter' && !event.isComposing) {
        event.preventDefault();
        event.stopPropagation();
        if (event.target === cancel) finish(false);
        else void submit();
        return;
      }
      if (event.key === 'Tab') {
        // Keep focus inside the dialog: wrap between its first and last control.
        const controls = [input, cancel, confirm].filter((control) => !control.disabled);
        const at = controls.indexOf(document.activeElement as HTMLInputElement | HTMLButtonElement);
        const next = event.shiftKey
          ? (at <= 0 ? controls.length - 1 : at - 1)
          : (at === controls.length - 1 ? 0 : at + 1);
        event.preventDefault();
        controls[next]?.focus();
        return;
      }
      // Nothing typed here may reach the editor shortcuts behind the dialog.
      event.stopPropagation();
    });

    dialog.append(title, description, input, status, actions);
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);
    input.focus();
  });
}

/** The host a link points at, for the busy message. */
function linkLabel(src: string): string {
  try {
    return new URL(src).hostname.replace(/^www\./, '');
  } catch {
    return 'the link';
  }
}

/**
 * Load the address once to learn what it is and how big, inside one shared
 * deadline. Null if it opens as neither an image nor a video, if the deadline
 * passes, or if the dialog closes first.
 */
async function probeLink(src: string, cancelled: AbortSignal): Promise<ProbedLink | null> {
  const signal = probeDeadline(cancelled, PROBE_TIMEOUT_MS);
  if (videoEmbedFor(src)) return { kind: 'video', ...EMBED_SIZE, poster: await linkedVideoPoster(src, signal) };
  const guess = linkedMediaKind(src);
  if (guess === 'video') return probeMedia('video', src, signal);
  if (guess === 'image') return probeMedia('image', src, signal);
  // No telling extension (a CDN or image-service URL): try both, in one budget.
  return (await probeMedia('image', src, signal)) ?? probeMedia('video', src, signal);
}

function probeMedia(kind: 'image' | 'video', src: string, signal: AbortSignal): Promise<ProbedLink | null> {
  if (signal.aborted) return Promise.resolve(null);
  return new Promise((resolve) => {
    const media = kind === 'image' ? new Image() : document.createElement('video');
    if (media instanceof HTMLVideoElement) {
      media.preload = 'metadata';
      media.muted = true;
    }
    const ready = kind === 'image' ? 'load' : 'loadedmetadata';
    const done = (result: ProbedLink | null): void => {
      media.removeEventListener(ready, onReady);
      media.removeEventListener('error', onError);
      signal.removeEventListener('abort', onError);
      // Drop the request on every way out, so an abandoned probe stops fetching.
      media.removeAttribute('src');
      if (media instanceof HTMLVideoElement) media.load();
      resolve(result);
    };
    const onReady = (): void => {
      const width = media instanceof HTMLImageElement ? media.naturalWidth : media.videoWidth;
      const height = media instanceof HTMLImageElement ? media.naturalHeight : media.videoHeight;
      done(width > 0 && height > 0 ? { kind, width, height } : null);
    };
    const onError = (): void => done(null);
    media.addEventListener(ready, onReady);
    media.addEventListener('error', onError);
    signal.addEventListener('abort', onError);
    media.src = src;
  });
}

/** Put linked media on the current slide, sized and centred like a dropped file. */
export function insertLinkedMedia(store: EditorStore, src: string, probed: ProbedLink): string {
  const id = makeId(probed.kind);
  store.commit((deck) => {
    const slide = deck.slides[store.get().slideIndex];
    if (!slide) return;
    const scale = Math.min(1, (deck.canvas.w * 0.8) / probed.width, (deck.canvas.h * 0.8) / probed.height);
    const w = Math.round(probed.width * scale);
    const h = Math.round(probed.height * scale);
    const base = {
      id,
      x: Math.round((deck.canvas.w - w) / 2),
      y: Math.round((deck.canvas.h - h) / 2),
      w,
      h,
      rot: 0,
      z: slide.elements.reduce((max, element) => Math.max(max, element.z), 0) + 1,
      opacity: 1,
      class: [],
      style: {},
      src,
      fit: NEW_MEDIA_FIT,
      sourceBox: null,
    };
    const embedded = videoEmbedFor(src) !== null;
    slide.elements.push(probed.kind === 'video'
      ? {
          ...base,
          type: 'video',
          // A provider player is started by the presenter, with its own
          // controls and sound; a linked file plays like a dropped clip.
          autoplay: !embedded,
          loop: !embedded,
          muted: !embedded,
          controls: embedded,
          // A pasted `?t=90` is where the clip starts; the inspector's Start owns it from here.
          start: linkedMediaStart(src),
          end: null,
          poster: probed.poster ?? null,
        }
      : { ...base, type: 'image', alt: '' });
  }, { label: probed.kind === 'video' ? 'Insert linked video' : 'Insert linked image' });
  store.select([id]);
  return id;
}
