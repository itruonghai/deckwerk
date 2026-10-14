/**
 * Links are authored slide content, so they must never replace the editor or
 * presentation document that happens to be rendering them.
 */
export function prepareSlideLinks(root: ParentNode): void {
  for (const anchor of root.querySelectorAll<HTMLAnchorElement>('a[href]')) {
    anchor.target = '_blank';
    const rel = new Set(anchor.rel.split(/\s+/).filter(Boolean));
    rel.add('noopener');
    anchor.rel = [...rel].join(' ');
  }

  // Sandboxed HTML elements use an open shadow root. querySelectorAll does not
  // cross that boundary, so prepare those authored links explicitly too.
  for (const element of root.querySelectorAll<HTMLElement>('*')) {
    if (element.shadowRoot) prepareSlideLinks(element.shadowRoot);
  }
}

/** Find an authored link even when the event crossed an HTML element's shadow root. */
export function slideLinkFromEvent(event: Event): HTMLAnchorElement | null {
  for (const target of event.composedPath()) {
    if (target instanceof HTMLAnchorElement && target.hasAttribute('href')) return target;
  }
  return event.target instanceof Element
    ? event.target.closest<HTMLAnchorElement>('a[href]')
    : null;
}

/**
 * Whether a pointer event is over a web element that takes its own input.
 * Clicks that land on such a page are the page's — they must never advance
 * the deck — and a sandboxed frame can surface them to the host with the
 * frame itself as the target, so the check is on the frame, not on what is
 * inside it. An inert page (pointer-events: none) is skipped by hit-testing
 * and never reaches here.
 */
export function eventOnInteractiveWeb(event: Event): boolean {
  // A YouTube or Vimeo player (`video-embed-frame`) takes its own clicks too:
  // pressing play must not also move the deck on.
  for (const target of event.composedPath()) {
    if (target instanceof HTMLIFrameElement
      && (target.classList.contains('web-frame') || target.classList.contains('video-embed-frame'))) return true;
  }
  return event.target instanceof Element
    && event.target.closest('iframe.web-frame, iframe.video-embed-frame') !== null;
}

/** Activate a slide link explicitly when a host (the editor) owns pointer input. */
export function openSlideLinkInNewTab(
  event: Event,
  open: (url: string, target: string, features: string) => unknown = window.open.bind(window),
): boolean {
  const anchor = slideLinkFromEvent(event);
  if (!anchor) return false;
  event.preventDefault();
  open(anchor.href, '_blank', 'noopener');
  return true;
}
