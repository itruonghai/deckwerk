// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { type Deck, parseDeck } from '../src/shared/deck.js';
import {
  LINKED_MEDIA_FRAME_ORIGINS,
  deckLinkedMedia,
  embedPlayerUrl,
  isLinkedMediaSrc,
  linkedMediaKind,
  linkedMediaStart,
  linkedVideoWatchUrl,
  videoEmbedFor,
  withLinkedMedia,
} from '../src/shared/linkedMedia.js';
import { pauseVideoEmbeds, renderSlide } from '../src/renderer/player/render.js';
import { buildPrintPages } from '../src/renderer/print/pages.js';
import { referencedAssets } from '../src/main/exportDeck.js';
import { collectAssetSrcs } from '../src/shared/clipboard.js';
import { sanitizeAuthoredHtml } from '../src/shared/htmlSafety.js';
import { slidesFromMeasured, type MeasuredSlide } from '../src/shared/htmlSlides.js';
import { validateDeckIntegrity } from '../src/shared/agent.js';

/**
 * Linked media: an image or video whose src is an https: address, shown
 * without being copied into the deck. YouTube and Vimeo links play in the
 * provider's player; a PDF page turns a linked video into a click-through.
 */

const YOUTUBE = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';

function deckWith(elements: Array<Record<string, unknown>>): Deck {
  return parseDeck({
    version: 1,
    slides: [{
      id: 's1',
      elements: elements.map((el, i) => ({ id: `e${i}`, x: 100, y: 100, w: 640, h: 360, ...el })),
    }],
  });
}

const resolveSrc = withLinkedMedia((src) => `deck://key/${src}`);

describe('recognising linked media', () => {
  it('accepts https addresses only', () => {
    expect(isLinkedMediaSrc('https://example.com/a.png')).toBe(true);
    expect(isLinkedMediaSrc('  https://example.com/a.png ')).toBe(true);
    for (const src of ['assets/a.png', 'http://example.com/a.png', 'file:///etc/passwd', 'deck://x/a.png', 'https://', 'https://?', 'https://localhost/a.png', '', null]) {
      expect(isLinkedMediaSrc(src), String(src)).toBe(false);
    }
  });

  it('passes linked media through every resolver, and resolves deck files as before', () => {
    expect(resolveSrc('https://example.com/a.png')).toBe('https://example.com/a.png');
    expect(resolveSrc('assets/a.png')).toBe('deck://key/assets/a.png');
  });

  it.each([
    [YOUTUBE, { provider: 'youtube', id: 'dQw4w9WgXcQ' }],
    ['https://youtu.be/dQw4w9WgXcQ?t=42', { provider: 'youtube', id: 'dQw4w9WgXcQ' }],
    ['https://m.youtube.com/shorts/dQw4w9WgXcQ', { provider: 'youtube', id: 'dQw4w9WgXcQ' }],
    ['https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ', { provider: 'youtube', id: 'dQw4w9WgXcQ' }],
    ['https://vimeo.com/76979871', { provider: 'vimeo', id: '76979871' }],
    ['https://vimeo.com/76979871/8a1b2c3d4e', { provider: 'vimeo', id: '76979871', hash: '8a1b2c3d4e' }],
    ['https://player.vimeo.com/video/76979871?h=8a1b2c3d4e', { provider: 'vimeo', id: '76979871', hash: '8a1b2c3d4e' }],
  ])('reads %s as a provider video', (src, expected) => {
    expect(videoEmbedFor(src)).toEqual(expected);
  });

  it('does not mistake other pages or files for provider videos', () => {
    for (const src of [
      'https://www.youtube.com/', 'https://www.youtube.com/@channel', 'https://vimeo.com/about',
      'https://example.com/watch?v=dQw4w9WgXcQ',
      // A playlist and a showcase have no single clip to embed.
      'https://www.youtube.com/embed/videoseries?list=PL1234567890', 'https://vimeo.com/showcase/1234567',
    ]) {
      expect(videoEmbedFor(src), src).toBeNull();
    }
  });

  it('reads the video, not the showcase or group, out of a Vimeo collection link', () => {
    expect(videoEmbedFor('https://vimeo.com/showcase/1234567/video/76979871')).toEqual({ provider: 'vimeo', id: '76979871' });
    expect(videoEmbedFor('https://vimeo.com/groups/name/videos/76979871')).toEqual({ provider: 'vimeo', id: '76979871' });
  });

  it.each([
    ['https://youtu.be/a-b_cD12345?t=1m30s', 90],
    ['https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42', 42],
    ['https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=1h2m3s', 3723],
    ['https://www.youtube.com/embed/dQw4w9WgXcQ?start=15', 15],
    ['https://vimeo.com/76979871#t=20s', 20],
    [YOUTUBE, 0],
    ['https://example.com/clip.mp4?t=30', 0],
  ])('starts %s at its pasted time stamp (%i s)', (src, seconds) => {
    expect(linkedMediaStart(src)).toBe(seconds);
  });

  it('guesses what a pasted link is from its address', () => {
    expect(linkedMediaKind(YOUTUBE)).toBe('video');
    expect(linkedMediaKind('https://cdn.example.com/run/rollout.mp4?sig=1')).toBe('video');
    expect(linkedMediaKind('https://example.com/fig/loss.PNG')).toBe('image');
    expect(linkedMediaKind('https://images.example.com/abc123')).toBeNull();
    expect(linkedMediaKind('assets/x.png')).toBeNull();
  });

  it('carries the trim and playback flags into the provider player', () => {
    const youtube = new URL(embedPlayerUrl(videoEmbedFor(YOUTUBE)!, {
      start: 12.4, end: 30.2, loop: true, muted: true,
    }));
    expect(youtube.origin).toBe('https://www.youtube-nocookie.com');
    expect(youtube.searchParams.get('start')).toBe('12');
    expect(youtube.searchParams.get('end')).toBe('31');
    expect(youtube.searchParams.get('mute')).toBe('1');
    expect(youtube.searchParams.get('playlist')).toBe('dQw4w9WgXcQ');
    // Never starts itself (it would be heard before its build shows it), and
    // listens for the deck's pause.
    expect(youtube.searchParams.has('autoplay')).toBe(false);
    expect(youtube.searchParams.get('enablejsapi')).toBe('1');

    const vimeo = embedPlayerUrl(videoEmbedFor('https://vimeo.com/76979871/8a1b2c3d4e')!, {
      start: 5, end: null, loop: false, muted: false,
    });
    expect(vimeo).toBe('https://player.vimeo.com/video/76979871?dnt=1&title=0&byline=0&portrait=0&api=1&h=8a1b2c3d4e#t=5s');
  });

  it('every slide window lets the provider players, linked pictures and video load', () => {
    const root = join(__dirname, '..', 'src', 'renderer');
    for (const name of ['editor', 'present', 'presenter', 'print']) {
      const html = readFileSync(join(root, name, 'index.html'), 'utf8');
      const policy = /http-equiv="Content-Security-Policy"[\s\S]*?content="([^"]*)"/i.exec(html)![1];
      const directive = (key: string) => new RegExp(`${key}([^;]*)`).exec(policy)?.[1] ?? '';
      for (const origin of LINKED_MEDIA_FRAME_ORIGINS) expect(directive('frame-src'), name).toContain(origin);
      expect(directive('img-src'), name).toMatch(/(^|\s)https:(\s|$)/);
      expect(directive('media-src'), name).toMatch(/(^|\s)https:(\s|$)/);
    }
  });
});

describe('drawing linked media', () => {
  it('shows a linked picture and video at their own address', () => {
    const deck = deckWith([
      { type: 'image', src: 'https://example.com/fig.png' },
      { type: 'video', src: 'https://example.com/clip.mp4' },
    ]);
    const root = renderSlide(deck.slides[0], { resolveSrc, mediaPreload: 'metadata' });
    expect(root.querySelector('img')!.getAttribute('src')).toBe('https://example.com/fig.png');
    const video = root.querySelector('video')!;
    expect(video.getAttribute('src')).toBe('https://example.com/clip.mp4');
    // A third-party host need not answer CORS; asking would fail the load.
    expect(video.crossOrigin).toBeNull();
  });

  it('presents a YouTube link in the provider player, with clicks of its own', () => {
    const deck = deckWith([{ type: 'video', src: YOUTUBE, controls: true, autoplay: false }]);
    const root = renderSlide(deck.slides[0], { resolveSrc });
    expect(root.querySelector('video')).toBeNull();
    const frame = root.querySelector<HTMLIFrameElement>('iframe.video-embed-frame')!;
    expect(new URL(frame.src).pathname).toBe('/embed/dQw4w9WgXcQ');
    expect(frame.getAttribute('allow')).toContain('fullscreen');
  });

  it('pauses provider players through their own message API', () => {
    const deck = deckWith([
      { type: 'video', src: YOUTUBE },
      { type: 'video', src: 'https://vimeo.com/76979871' },
    ]);
    const root = renderSlide(deck.slides[0], { resolveSrc });
    document.body.appendChild(root);
    const sent: Array<[unknown, string]> = [];
    for (const frame of root.querySelectorAll('iframe')) {
      Object.defineProperty(frame, 'contentWindow', {
        value: { postMessage: (message: unknown, origin: string) => sent.push([message, origin]) },
      });
    }
    pauseVideoEmbeds(root);
    root.remove();
    expect(sent).toEqual([
      [JSON.stringify({ event: 'command', func: 'pauseVideo', args: [] }), 'https://www.youtube-nocookie.com'],
      [JSON.stringify({ method: 'pause' }), 'https://player.vimeo.com'],
    ]);
  });

  it('previews a YouTube link as its thumbnail, with no live player', () => {
    const deck = deckWith([{ type: 'video', src: YOUTUBE }]);
    const root = renderSlide(deck.slides[0], { resolveSrc, mediaPreload: 'metadata' });
    expect(root.querySelector('iframe')).toBeNull();
    expect(root.querySelector('img')!.src).toBe('https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg');
    expect(root.querySelector('.video-embed-badge')).not.toBeNull();
  });
});

describe('linked video on a PDF page', () => {
  it('becomes a link to the video, at its in-point', () => {
    const deck = deckWith([
      { type: 'video', src: YOUTUBE, start: 75 },
      { type: 'video', src: 'https://example.com/clip.mp4' },
      { type: 'video', src: 'assets/local.mp4' },
    ]);
    const container = document.createElement('div');
    buildPrintPages(container, { deck, mode: 'final', resolveSrc });
    const links = [...container.querySelectorAll<HTMLAnchorElement>('a.pdf-video-link')];
    expect(links.map((link) => link.href)).toEqual([
      'https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=75s',
      'https://example.com/clip.mp4',
    ]);
    // The provider player never loads on a printed page: the still does.
    expect(container.querySelector('iframe')).toBeNull();
    expect(container.querySelector('[data-element-id="e0"] img')).not.toBeNull();
    // A video stored in the deck has no address outside it.
    expect(container.querySelector('[data-element-id="e2"] a')).toBeNull();
  });

  it('watch links name the provider page, not the embed', () => {
    expect(linkedVideoWatchUrl('https://player.vimeo.com/video/76979871?h=8a1b2c3d4e', 3))
      .toBe('https://vimeo.com/76979871/8a1b2c3d4e#t=3s');
    expect(linkedVideoWatchUrl('assets/local.mp4')).toBeNull();
  });
});

describe('linked media is not a deck file', () => {
  const deck = deckWith([
    { type: 'image', src: 'https://example.com/fig.png' },
    { type: 'video', src: YOUTUBE },
    { type: 'image', src: 'assets/local.png' },
  ]);

  it('web export copies only the deck files', () => {
    expect([...referencedAssets(deck)]).toEqual(['assets/local.png']);
  });

  it('copying to another deck copies only the deck files', () => {
    expect(collectAssetSrcs({ kind: 'elements', elements: deck.slides[0].elements, timeline: [], sourceSlideId: 's1' }))
      .toEqual(['assets/local.png']);
  });

  it('is not reported as a missing asset', () => {
    const errors = validateDeckIntegrity(deck, (src) => src === 'assets/local.png');
    expect(errors.filter((error) => error.includes('Missing asset'))).toEqual([]);
  });

  it('lists the addresses the deck already links, in the spellings the export writes', () => {
    const linked = deckWith([
      { type: 'image', src: 'https://example.com/fig.png' },
      { type: 'video', src: 'https://example.com/clip.mp4', start: 2.5, poster: 'https://example.com/still.jpg' },
      { type: 'image', src: 'assets/local.png' },
    ]);
    expect([...deckLinkedMedia(linked)].sort()).toEqual([
      'https://example.com/clip.mp4', 'https://example.com/clip.mp4#t=2.5', 'https://example.com/fig.png', 'https://example.com/still.jpg',
    ]);
  });

  it('survives the authored-HTML round trip, while every other external fetch is still removed', () => {
    const allowed = deckLinkedMedia(deck);
    const { html, report } = sanitizeAuthoredHtml(
      `<img data-element-id="e0" src="https://example.com/fig.png"><video data-element-id="e1" src="${YOUTUBE}"></video>`
      // An address the deck does not link, even dressed as a deck object.
      + '<img data-element-id="fake" src="https://tracker.example/pixel">'
      + '<img src="ht&#9;tps://tracker.example/tab"><img src="//tracker.example/relative">'
      + '<style>.x { background: url(//tracker.example/style.png) }</style>'
      + '<img src="assets/local.png" srcset="https://tracker.example/2x.png 2x">'
      + '<div style="background-image:url(https://tracker.example/bg.png)">x</div>',
      allowed,
    );
    expect(html).toContain('src="https://example.com/fig.png"');
    expect(html).toContain(`src="${YOUTUBE}"`);
    expect(html).not.toContain('tracker.example');
    expect(report.blockedUrls).toHaveLength(6);
  });

  it('removes even the deck\'s own links from markup compiled without the deck (imports)', () => {
    const { html } = sanitizeAuthoredHtml('<img data-element-id="e0" src="https://example.com/fig.png">');
    expect(html).not.toContain('https://example.com/fig.png');
  });
});

describe('compiled authored HTML cannot add an external fetch', () => {
  const node = (over: Record<string, unknown>) => ({
    tag: 'div', elementId: null, classes: [], dataset: {},
    rect: { x: 0, y: 0, w: 100, h: 100 }, rotation: 0, opacity: 1,
    style: {}, html: '', attrs: {}, ...over,
  });
  const page = (nodes: Array<Record<string, unknown>>) => [{
    id: 's1', name: '', notes: '', background: { color: null, image: 'https://tracker.example/bg.png' },
    morphFromPrevious: false, nodes,
  }] as unknown as MeasuredSlide[];

  it('keeps the deck\'s own linked media and drops every other address, however it is spelled', () => {
    const deck = deckWith([{ type: 'image', src: 'https://example.com/fig.png' }]);
    const [slide] = slidesFromMeasured(deck, page([
      node({ tag: 'img', elementId: 'e0', attrs: { src: 'https://example.com/fig.png' } }),
      node({ tag: 'img', elementId: 'spoof', attrs: { src: 'ht\ttps://tracker.example/tab.png' } }),
      node({ tag: 'img', elementId: 'slashes', attrs: { src: '\\\\tracker.example/backslash.png' } }),
      node({ tag: 'div', elementId: 'cropped', dataset: { element: 'image', src: 'https://tracker.example/crop.png', crop: '0,0,100,100' } }),
      node({ tag: 'img', elementId: 'local', attrs: { src: 'assets/local.png' } }),
      node({
        tag: 'p', elementId: 'text', style: { 'background-image': 'url(//tracker.example/css.png)' },
        html: '<img src="//tracker.example/inline.png"> <a href="https://example.com/paper">paper</a>',
      }),
    ]));
    const json = JSON.stringify(slide);
    expect(json).not.toContain('tracker.example');
    expect(slide.background.image).toBeNull();
    const media = slide.elements.filter((el) => el.type === 'image').map((el) => el.type === 'image' && el.src);
    expect(media).toEqual(['https://example.com/fig.png', 'assets/local.png']);
    // A link a person clicks is not a fetch, and stays.
    expect(json).toContain('href=\\"https://example.com/paper\\"');
  });
});
