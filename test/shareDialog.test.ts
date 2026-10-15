// @vitest-environment jsdom
/**
 * The share dialog, laid out the way Google Docs settled on: "People with
 * access" — the owner and every named grant, each with its own role — above
 * "General access", the single rule for everyone else, with a plain sentence
 * saying what the two of them add up to.
 *
 * The rules themselves live in `accessControl.ts` and are tested there. What
 * matters here is that the dialog states them truthfully: the sentence under
 * General access is the only place anyone reads what "public" means, so a
 * wrong one is worse than none.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { showShareDialog } from '../src/renderer/collab/deckPicker.js';

const OWNER = 'alice@tailnet.example';
const BOB = 'bob@tailnet.example';

const ACCESS = {
  owner: OWNER,
  visibility: 'private' as 'private' | 'public',
  publicRole: 'view' as 'view' | 'edit',
  sharedWith: [{ login: BOB, role: 'edit' as 'edit' | 'view' }],
  canManage: true,
  role: 'owner' as const,
};

const USERS = [{ login: OWNER, name: 'Alice' }, { login: BOB, name: 'Bob' }];

/** Open the dialog against a stubbed server and wait for it to render. */
async function openDialog(access: Partial<typeof ACCESS> = {}): Promise<{ status: string[] }> {
  const status: string[] = [];
  const info = { ...ACCESS, ...access };
  vi.stubGlobal('fetch', vi.fn(async (input: string, init?: RequestInit) => {
    const sent = init?.method === 'PUT' ? JSON.parse(String(init.body)) as { link?: string } : null;
    const json = input.startsWith('/api/users') ? USERS
      : sent?.link ? {
        linkUrl: sent.link === 'off' ? null
          : sent.link === 'anyone' ? `https://view.example.com/?deck=talk&view=${sent.link}-secret`
            : `https://slides.example.com/?deck=talk&invite=${sent.link}-secret`,
        link: sent.link === 'off' ? null : { role: 'view', anyone: sent.link === 'anyone' },
      }
        : sent ? {}
          : info;
    return new Response(JSON.stringify(json), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
  }));
  showShareDialog('talk', (text) => status.push(text));
  await vi.waitFor(() => expect(document.querySelector('.share-dialog-people')).not.toBeNull());
  return { status };
}

const sectionNames = (): string[] =>
  [...document.querySelectorAll('.share-dialog-section h3')].map((h) => h.textContent ?? '');

const peopleRows = (): string[] =>
  [...document.querySelectorAll('.share-dialog-person')].map((row) =>
    [...row.querySelectorAll('.share-dialog-person-name, .share-dialog-role-fixed')]
      .map((node) => node.textContent).join(' — '));

const generalSelects = (): HTMLSelectElement[] =>
  [...document.querySelectorAll<HTMLSelectElement>('.share-dialog-general select')];

const note = (): string => document.querySelector('.share-dialog-note')?.textContent ?? '';

describe('share dialog', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('shows people above general access', async () => {
    await openDialog();
    expect(sectionNames()).toEqual(['People with access', 'General access', 'Link']);
  });

  it('lists the owner as a person, not as a caption', async () => {
    await openDialog();
    // Showing the owner in the list answers "why can't I remove myself"
    // before it is asked, and puts every role in one column.
    expect(peopleRows()).toEqual(['Alice — Owner', 'Bob']);
    expect(document.querySelector('.share-dialog-owner')).toBeNull();
  });

  it('describes a restricted deck without offering a meaningless role', async () => {
    await openDialog({ visibility: 'private' });
    const [visibility, publicRole] = generalSelects();

    expect(visibility.value).toBe('private');
    expect(publicRole.hidden).toBe(true);
    expect(note()).toBe('Only the people listed above can open it.');
  });

  it('spells out that a public view-only deck is readable but not writable', async () => {
    await openDialog({ visibility: 'public', publicRole: 'view' });
    const [, publicRole] = generalSelects();

    expect(publicRole.hidden).toBe(false);
    expect(note())
      .toBe('Anyone on the tailnet can open it. Only the people listed above can change it.');
  });

  it('says plainly when public means anyone can change it', async () => {
    await openDialog({ visibility: 'public', publicRole: 'edit' });
    expect(note()).toBe('Anyone on the tailnet can open and change it.');
  });

  it('rewrites the sentence as the controls change', async () => {
    await openDialog({ visibility: 'private' });
    const [visibility, publicRole] = generalSelects();

    visibility.value = 'public';
    visibility.dispatchEvent(new Event('change'));
    expect(publicRole.hidden).toBe(false);
    expect(note()).toContain('Only the people listed above can change it.');

    publicRole.value = 'edit';
    publicRole.dispatchEvent(new Event('change'));
    expect(note()).toBe('Anyone on the tailnet can open and change it.');

    visibility.value = 'private';
    visibility.dispatchEvent(new Event('change'));
    expect(publicRole.hidden).toBe(true);
    expect(note()).toBe('Only the people listed above can open it.');
  });

  it('saves the two sections as one access payload', async () => {
    await openDialog({ visibility: 'private' });
    const [visibility, publicRole] = generalSelects();
    visibility.value = 'public';
    visibility.dispatchEvent(new Event('change'));
    publicRole.value = 'view';

    document.querySelector<HTMLButtonElement>('.workflow-actions .primary')!.click();
    await vi.waitFor(() => expect(
      vi.mocked(fetch).mock.calls.some((call) => call[1]?.method === 'PUT'),
    ).toBe(true));

    const put = vi.mocked(fetch).mock.calls.find((call) => call[1]?.method === 'PUT')!;
    expect(JSON.parse(String(put[1]!.body))).toEqual({
      visibility: 'public',
      publicRole: 'view',
      sharedWith: [{ login: BOB, role: 'edit' }],
      // The list as the dialog found it: the server applies only the changes.
      sharedWithBase: [{ login: BOB, role: 'edit' }],
    });
  });

  it('copies the deck link, so sharing does not mean hunting in the address bar', async () => {
    const writeText = vi.fn(async (_text: string) => {});
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    const { status } = await openDialog();

    document.querySelector<HTMLButtonElement>('.share-dialog-copy')!.click();
    await vi.waitFor(() => expect(writeText).toHaveBeenCalled());

    expect(writeText.mock.calls[0][0]).toBe(`${location.origin}/?deck=talk`);
    expect(status.at(-1)).toContain('Copied the link');
  });

  it('offers the link to copy by hand when the browser refuses the clipboard', async () => {
    vi.stubGlobal('navigator', { clipboard: { writeText: async () => { throw new Error('denied'); } } });
    const { status } = await openDialog();

    document.querySelector<HTMLButtonElement>('.share-dialog-copy')!.click();
    await vi.waitFor(() => expect(status.at(-1)).toContain('Copy it by hand'));
    expect(status.at(-1)).toContain('?deck=talk');
  });

  it('tells a viewer where they stand instead of showing them controls', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ ...ACCESS, visibility: 'public', canManage: false, role: 'view' }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )));
    showShareDialog('talk', () => {});
    await vi.waitFor(() => expect(document.querySelector('.share-dialog-owner')).not.toBeNull());

    expect(document.body.textContent).toContain('You can view it, but not change it.');
    expect(document.querySelector('.share-dialog-general')).toBeNull();
  });

  it('turns "anyone with the link can view" on, copies that link, and resets it', async () => {
    const written: string[] = [];
    vi.stubGlobal('navigator', { clipboard: { writeText: async (text: string) => void written.push(text) } });
    const { status } = await openDialog();
    const mode = document.querySelector<HTMLSelectElement>('.share-dialog-link select')!;
    const reset = [...document.querySelectorAll<HTMLButtonElement>('.share-dialog-link button')]
      .find((button) => button.textContent === 'Reset link')!;
    expect(mode.value).toBe('off');
    expect(reset.hidden).toBe(true);

    mode.value = 'on';
    mode.dispatchEvent(new Event('change'));
    await vi.waitFor(() => expect(reset.hidden).toBe(false));
    expect(status.at(-1)).toMatch(/Anyone with the link can view/);

    const copy = document.querySelector<HTMLButtonElement>('.share-dialog-copy')!;
    copy.click();
    await vi.waitFor(() => expect(written).toEqual(['https://slides.example.com/?deck=talk&invite=on-secret']));

    reset.click();
    await vi.waitFor(() => expect(status.at(-1)).toMatch(/old one no longer works/));
    copy.click();
    await vi.waitFor(() => expect(written.at(-1)).toBe('https://slides.example.com/?deck=talk&invite=reset-secret'));
  });

  it('offers a no-sign-in link only when the server has a view-link address', async () => {
    await openDialog();
    const options = () => [...document.querySelectorAll<HTMLOptionElement>('.share-dialog-link select option')].map((o) => o.value);
    expect(options()).toEqual(['off', 'on']);

    document.body.innerHTML = '';
    const written: string[] = [];
    vi.stubGlobal('navigator', { clipboard: { writeText: async (text: string) => void written.push(text) } });
    await openDialog({ anyoneLinks: true } as Partial<typeof ACCESS>);
    expect(options()).toEqual(['off', 'on', 'anyone']);
    const mode = document.querySelector<HTMLSelectElement>('.share-dialog-link select')!;
    mode.value = 'anyone';
    mode.dispatchEvent(new Event('change'));
    await vi.waitFor(() => expect(document.querySelector('.share-dialog-link + .share-dialog-note, .share-dialog-section:last-child .share-dialog-note')?.textContent)
      .toMatch(/without signing in/));
    const put = vi.mocked(fetch).mock.calls.filter((call) => call[1]?.method === 'PUT').at(-1)!;
    expect(JSON.parse(String(put[1]!.body))).toEqual({ link: 'anyone' });
    document.querySelector<HTMLButtonElement>('.share-dialog-copy')!.click();
    await vi.waitFor(() => expect(written).toEqual(['https://view.example.com/?deck=talk&view=anyone-secret']));
  });
});
