// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import {
  linkAtRange,
  linkHrefForInput,
  removeLinkAtSelection,
  retargetLink,
  setLinkAtSelection,
  unlinkAnchor,
} from '../src/renderer/editor/linkEditing.js';

/**
 * The DOM half of Cmd/Ctrl+K (textLinkDialog.ts): what the dialog does to the
 * selection it was opened on. The real-input path is textLinkShortcutBrowser.
 */

function box(html: string): HTMLElement {
  document.body.innerHTML = `<div class="text-content" contenteditable="true">${html}</div>`;
  return document.querySelector('.text-content')!;
}

/** Select `[start, end)` of the first text node containing `word`. */
function select(body: HTMLElement, word: string, from = 0, to = word.length): Selection {
  const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
    const at = node.data.indexOf(word);
    if (at < 0) continue;
    const range = document.createRange();
    range.setStart(node, at + from);
    range.setEnd(node, at + to);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    return selection;
  }
  throw new Error(`no text "${word}"`);
}

describe('the address typed into the link dialog', () => {
  it.each([
    ['https://example.com/a', 'https://example.com/a'],
    ['  www.example.org ', 'https://www.example.org'],
    ['arxiv.org/abs/2301.00001', 'https://arxiv.org/abs/2301.00001'],
    ['localhost.dev:8080/x', 'https://localhost.dev:8080/x'],
  ])('reads %s as %s', (typed, href) => {
    expect(linkHrefForInput(typed)).toBe(href);
  });

  it.each(['', 'not a link', 'javascript:alert(1)', 'mailto:me@example.com', 'file:///etc/passwd', 'paper'])(
    'refuses %j', (typed) => {
      expect(linkHrefForInput(typed)).toBeNull();
    },
  );
});

describe('setting and removing the link on a selection', () => {
  it('links the selected words', () => {
    const body = box('<p>Read our paper today</p>');
    const selection = select(body, 'paper');
    expect(setLinkAtSelection(body, selection, 'https://example.com/p')).toBe('Insert link');
    expect(body.innerHTML).toBe('<p>Read our <a href="https://example.com/p">paper</a> today</p>');
    // Still selected, so the next Cmd/Ctrl+K edits this link.
    expect(selection.toString()).toBe('paper');
    expect(linkAtRange(body, selection.getRangeAt(0))?.getAttribute('href')).toBe('https://example.com/p');
  });

  it('retargets the link the caret is in, and selects its words', () => {
    const body = box('<p>Read our <a href="https://old.example">paper</a> today</p>');
    const selection = select(body, 'paper', 2, 2);
    expect(linkAtRange(body, selection.getRangeAt(0))?.getAttribute('href')).toBe('https://old.example');
    expect(setLinkAtSelection(body, selection, 'https://new.example')).toBe('Edit link');
    expect(body.innerHTML).toBe('<p>Read our <a href="https://new.example">paper</a> today</p>');
    expect(selection.toString()).toBe('paper');
  });

  it('inserts the address at a bare caret, with a space so typing continues outside it', () => {
    const body = box('<p>Code: </p>');
    const selection = select(body, 'Code: ', 6, 6);
    expect(setLinkAtSelection(body, selection, 'https://github.com/a/b/')).toBe('Insert link');
    expect(body.innerHTML).toBe('<p>Code: <a href="https://github.com/a/b/">github.com/a/b</a> </p>');
    expect(linkAtRange(body, selection.getRangeAt(0))).toBeNull();
  });

  it('refuses a selection one link cannot carry, changing nothing', () => {
    const body = box('<p>one <a href="https://x.example">two</a> three</p>');
    // Half inside the link, half outside.
    const range = document.createRange();
    range.setStart(body.querySelector('a')!.firstChild!, 1);
    range.setEnd(body.querySelector('p')!.lastChild!, 3);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    const before = body.innerHTML;
    expect(setLinkAtSelection(body, selection, 'https://y.example')).toBeNull();
    expect(body.innerHTML).toBe(before);
  });

  it('removes the link the selection is in, keeping its words and formatting selected', () => {
    const body = box('<p>Read <a href="https://x.example"><b>our</b> paper</a></p>');
    const selection = select(body, 'paper', 1, 1);
    expect(removeLinkAtSelection(body, selection)).toBe(true);
    expect(body.innerHTML).toBe('<p>Read <b>our</b> paper</p>');
    expect(selection.toString()).toBe('our paper');
    expect(removeLinkAtSelection(body, selection)).toBe(false);
  });

  it('reuses a space already after the caret instead of adding a second', () => {
    // Caret right before an existing space: no second one.
    const body = box('<p>See here now</p>');
    const selection = select(body, 'See', 3, 3);
    expect(setLinkAtSelection(body, selection, 'https://x.example')).toBe('Insert link');
    expect(body.innerHTML).toBe('<p>See<a href="https://x.example">x.example</a> here now</p>');
    // Caret after a space, before a word: one is added so the word stays separate.
    const other = box('<p>See here</p>');
    setLinkAtSelection(other, select(other, 'See ', 4, 4), 'https://x.example');
    expect(other.innerHTML).toBe('<p>See <a href="https://x.example">x.example</a> here</p>');
  });

  it('inserts at the end of a list item in that item, not the next', () => {
    const body = box('<ul><li>one</li><li>two</li></ul>');
    const first = body.querySelector('li')!.firstChild as Text;
    const caret = document.createRange();
    caret.setStart(first, first.data.length);
    caret.collapse(true);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(caret);
    setLinkAtSelection(body, selection, 'https://x.example');
    expect(body.querySelectorAll('li')[0].innerHTML).toBe('one<a href="https://x.example">x.example</a> ');
    expect(body.querySelectorAll('li')[1].innerHTML).toBe('two');
  });

  it('treats a caret at the end of a link as in the link, to edit or remove it', () => {
    const body = box('<p><a href="https://old.example">paper</a> today</p>');
    const text = body.querySelector('a')!.firstChild as Text;
    const caret = document.createRange();
    caret.setStart(text, text.data.length);
    caret.collapse(true);
    const anchor = linkAtRange(body, caret)!;
    expect(anchor.getAttribute('href')).toBe('https://old.example');
    const selection = window.getSelection()!;
    expect(retargetLink(anchor, 'https://new.example', selection)).toBe('Edit link');
    expect(body.innerHTML).toBe('<p><a href="https://new.example">paper</a> today</p>');
    expect(unlinkAnchor(anchor, selection)).toBe(true);
    expect(body.innerHTML).toBe('<p>paper today</p>');
    expect(selection.toString()).toBe('paper');
  });
});
