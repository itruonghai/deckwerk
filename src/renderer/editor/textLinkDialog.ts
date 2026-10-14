import type { EditorCanvas } from './canvas.js';
import { linkHrefForInput } from './linkEditing.js';

/**
 * Cmd/Ctrl+K while editing text: add, change or remove the link on the
 * selection. Opened on the selected words it links them; inside a link it
 * shows that link's address to change, with Remove link beside it; on a bare
 * caret it inserts the address itself as a link.
 *
 * Shared workflow-dialog chrome, as linkMediaDialog.ts and confirmDialog.ts.
 * The text edit stays open underneath (the canvas lets focus move into
 * `.text-link-dialog` without finishing it), and the selection comes back
 * when the dialog closes, however it closes.
 */
export function showTextLinkDialog(canvas: EditorCanvas): Promise<boolean> {
  const target = canvas.textLinkTarget();
  if (!target) return Promise.resolve(false);
  const editing = target.href !== null;

  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'workflow-overlay';

    const dialog = document.createElement('section');
    dialog.className = 'workflow-dialog confirm-dialog text-link-dialog';
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-labelledby', 'text-link-title');

    const title = document.createElement('h2');
    title.id = 'text-link-title';
    title.textContent = editing ? 'Edit link' : 'Insert link';
    const description = document.createElement('p');
    description.className = 'confirm-dialog-description';
    const words = target.selectedText.trim();
    description.textContent = words
      ? `Link "${words.length > 80 ? `${words.slice(0, 80)}…` : words}" to:`
      : 'Insert a link at the cursor:';

    const input = document.createElement('input');
    input.type = 'url';
    input.className = 'link-media-input';
    input.placeholder = 'https://arxiv.org/abs/…';
    input.spellcheck = false;
    input.value = target.href ?? '';
    input.setAttribute('aria-label', 'Link address');

    const status = document.createElement('p');
    status.className = 'link-media-status link-media-error';
    status.setAttribute('role', 'alert');
    status.hidden = true;

    const actions = document.createElement('div');
    actions.className = 'workflow-actions';
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'danger';
    remove.textContent = 'Remove link';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.textContent = 'Cancel';
    const confirm = document.createElement('button');
    confirm.type = 'button';
    confirm.className = 'primary';
    confirm.textContent = editing ? 'Save' : 'Insert';
    if (editing) actions.append(remove);
    actions.append(cancel, confirm);

    let finished = false;
    // While the dialog is open the keyboard stays in it. A collaborator's edit
    // re-asserts the selection in the box underneath, which moves focus there;
    // without this, the next keys typed for the address would land in the slide.
    const keepFocus = (event: FocusEvent): void => {
      if (event.target instanceof Node && !dialog.contains(event.target)) input.focus();
    };
    document.addEventListener('focusin', keepFocus);
    const finish = (changed: boolean): void => {
      if (finished) return;
      finished = true;
      document.removeEventListener('focusin', keepFocus);
      overlay.remove();
      // A change already put the selection back on the link; a cancel puts it
      // back where the dialog found it.
      if (!changed) canvas.resumeTextEdit(target);
      resolve(changed);
    };
    const showError = (text: string): void => {
      status.hidden = false;
      status.textContent = text;
      input.focus();
    };
    const apply = (href: string | null): void => {
      // Applying hands the keyboard back to the box; the trap would take it.
      document.removeEventListener('focusin', keepFocus);
      const result = canvas.applyTextLink(target, href);
      if (result === 'done') {
        finish(true);
        return;
      }
      document.addEventListener('focusin', keepFocus);
      // Nothing changed. Say why, and leave the dialog for the author to cancel.
      showError(result === 'stale'
        ? 'The text changed while this was open (someone else may be editing it). Cancel, then select the words again.'
        : 'A link can cover words within one paragraph, and cannot overlap another link. Select fewer words.');
    };
    const submit = (): void => {
      const value = input.value.trim();
      if (!value && editing) {
        apply(null);
        return;
      }
      const href = linkHrefForInput(value);
      if (!href) {
        showError('Enter a web address, such as https://arxiv.org/abs/2301.00001');
        return;
      }
      apply(href);
    };

    remove.addEventListener('click', () => apply(null));
    cancel.addEventListener('click', () => finish(false));
    confirm.addEventListener('click', submit);
    // A click on the backdrop cancels. Not on pointerdown: the press's default
    // action would then move focus to the page once the dialog is gone, and the
    // text box reads that as "done editing". The press is kept from moving
    // focus at all, and the dialog closes on the click it completes.
    overlay.addEventListener('pointerdown', (event) => {
      if (event.target === overlay) event.preventDefault();
    });
    overlay.addEventListener('mousedown', (event) => {
      if (event.target === overlay) event.preventDefault();
    });
    overlay.addEventListener('click', (event) => {
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
        else if (event.target === remove) apply(null);
        else submit();
        return;
      }
      if (event.key === 'Tab') {
        // Keep focus inside the dialog: wrap between its first and last control.
        const controls = [input, ...actions.querySelectorAll('button')];
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
    input.select();
  });
}
