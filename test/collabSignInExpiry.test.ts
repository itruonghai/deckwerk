/**
 * A page behind Cloudflare Access whose sign-in runs out: the bridge must go
 * back through the sign-in (a page load) instead of retrying a socket the
 * edge will keep refusing — and must keep retrying as before for anything
 * that is only a dropped connection.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CollabBridge } from '../src/renderer/collab/collabBridge.js';

class FakeSocket extends EventTarget {
  static all: FakeSocket[] = [];
  readyState = 0;
  constructor(readonly url: string) {
    super();
    FakeSocket.all.push(this);
  }
  send(): void {}
  close(): void {}
  drop(code: number): void {
    const event = new Event('close') as Event & { code: number; reason: string };
    event.code = code;
    event.reason = '';
    this.dispatchEvent(event);
  }
}

describe('collab bridge when the sign-in runs out', () => {
  const reload = vi.fn();
  let configAnswer: { type: string; status: number } | Error | 'hang';

  beforeEach(() => {
    vi.useFakeTimers();
    FakeSocket.all = [];
    reload.mockReset();
    vi.stubGlobal('WebSocket', FakeSocket);
    const stored = new Map<string, string>();
    vi.stubGlobal('sessionStorage', {
      getItem: (k: string) => stored.get(k) ?? null,
      setItem: (k: string, v: string) => void stored.set(k, v),
    });
    vi.stubGlobal('location', { href: 'https://slides.example.com/?deck=d', protocol: 'https:', host: 'slides.example.com', reload });
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: { signal?: AbortSignal }) => {
      if (configAnswer === 'hang') {
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        });
      }
      if (configAnswer instanceof Error) throw configAnswer;
      return configAnswer;
    }));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  const bridge = (onStatus = vi.fn()) => {
    const instance = new CollabBridge('wss://slides.example.com/ws?deck=d', 'Prof', {
      onDeckReplaced: vi.fn(), onWelcome: vi.fn(), onPeerPresence: vi.fn(), onPeerCursor: vi.fn(),
      onPeerLeft: vi.fn(), onThemeCss: vi.fn(), onStatus, onCleanChange: vi.fn(),
    });
    instance.connect();
    return instance;
  };

  it('reloads at once when the server says the sign-in expired', () => {
    bridge();
    FakeSocket.all[0].drop(4401);
    expect(reload).toHaveBeenCalledOnce();
  });

  it('does not reload in a loop when the sign-in keeps being refused', () => {
    const onStatus = vi.fn();
    bridge();
    FakeSocket.all[0].drop(4401);
    bridge(onStatus);
    FakeSocket.all[1].drop(4401);
    expect(reload).toHaveBeenCalledOnce();
    expect(onStatus).toHaveBeenLastCalledWith('Your sign-in could not be renewed. Reload the page to sign in again.');
  });

  it('reconnects anyway when the sign-in probe never answers', async () => {
    configAnswer = 'hang';
    bridge();
    FakeSocket.all[0].drop(1006);
    await vi.advanceTimersByTimeAsync(600 + 5_000);
    expect(FakeSocket.all).toHaveLength(2);
    expect(reload).not.toHaveBeenCalled();
  });

  it('reloads when a dropped socket turns out to be the sign-in redirect', async () => {
    configAnswer = { type: 'opaqueredirect', status: 0 };
    bridge();
    FakeSocket.all[0].drop(1006);
    await vi.advanceTimersByTimeAsync(600);
    expect(reload).toHaveBeenCalledOnce();
    expect(FakeSocket.all).toHaveLength(1);
  });

  it('just reconnects when the server answers, or the network is down', async () => {
    configAnswer = { type: 'basic', status: 200 };
    bridge();
    FakeSocket.all[0].drop(1006);
    await vi.advanceTimersByTimeAsync(600);
    expect(FakeSocket.all).toHaveLength(2);

    configAnswer = new Error('offline');
    FakeSocket.all[1].drop(1006);
    await vi.advanceTimersByTimeAsync(1100);
    expect(FakeSocket.all).toHaveLength(3);
    expect(reload).not.toHaveBeenCalled();
  });

  it('never probes another host’s server (the desktop editor joining a session)', async () => {
    vi.stubGlobal('location', { href: 'file:///app/index.html', protocol: 'file:', host: '', reload });
    configAnswer = { type: 'opaqueredirect', status: 0 };
    bridge();
    FakeSocket.all[0].drop(1006);
    await vi.advanceTimersByTimeAsync(600);
    expect(fetch).not.toHaveBeenCalled();
    expect(FakeSocket.all).toHaveLength(2);
  });
});
