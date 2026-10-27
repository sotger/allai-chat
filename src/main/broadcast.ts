import type { BroadcastResult } from '@shared/ipc';
import type { ServiceTab } from '@shared/types';
import { contentsForTab } from './search';

/**
 * Finds the message composer on a service page, puts the caret at the end and
 * remembers the element for the submit step.
 *
 * Every service uses a different editor (textarea, ProseMirror, Lexical, Quill,
 * a plain contenteditable). Instead of hardcoding selectors per provider, pick
 * the bottom-most edit box outside navigation areas and prefer the ones whose
 * attributes look like a chat input. This is heuristic, so the UI reports
 * per-service failures instead of silently doing nothing.
 */
const focusComposerScript = `(() => {
  const hint = (el) => [
    el.id,
    el.getAttribute('placeholder'),
    el.getAttribute('aria-label'),
    el.getAttribute('data-testid'),
    el.getAttribute('data-placeholder'),
    typeof el.className === 'string' ? el.className : ''
  ].join(' ');

  const candidates = [...document.querySelectorAll('textarea, input[type="text"], [contenteditable="true"], [contenteditable=""], [role="textbox"]')]
    .filter((el) => !el.disabled && !el.readOnly)
    .filter((el) => el.getAttribute('role') !== 'searchbox')
    .filter((el) => (el.getAttribute('type') || '').toLowerCase() !== 'search')
    .filter((el) => !el.closest('nav, aside, header, [role="navigation"], [role="menu"]'))
    .map((el) => {
      const rect = el.getBoundingClientRect();
      const attrs = hint(el);
      let score = rect.bottom * 4 + rect.width;
      if (/message|prompt|ask|chat|send|вопрос|сообщ|запрос/i.test(attrs)) score += 100000;
      if (/search|поиск/i.test(attrs)) score -= 200000;
      if (el.closest('form')) score += 500;
      return { el, score };
    })
    .sort((a, b) => b.score - a.score);

  const target = candidates[0]?.el;
  if (!target) return { ok: false, reason: 'Message box not found' };

  target.focus();

  if (target.isContentEditable) {
    const range = document.createRange();
    range.selectNodeContents(target);
    range.collapse(false);
    const selection = window.getSelection();
    if (selection) {
      selection.removeAllRanges();
      selection.addRange(range);
    }
  } else if (typeof target.setSelectionRange === 'function') {
    const end = target.value.length;
    target.setSelectionRange(end, end);
  }

  window.__allaiComposer = target;
  return { ok: true };
})()`;

/** Clicks the send button next to the composer, if one can be identified. */
const submitComposerScript = `(() => {
  const composer = window.__allaiComposer;
  const scope = composer && composer.closest('form') ? composer.closest('form') : document;
  const composerRect = composer ? composer.getBoundingClientRect() : null;
  const buttons = [...scope.querySelectorAll('button, [role="button"], input[type="submit"]')]
    .filter((el) => !el.disabled && el.getAttribute('aria-disabled') !== 'true')
    .filter((el) => {
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    });

  const labelled = buttons.find((el) => {
    const text = [el.getAttribute('aria-label'), el.getAttribute('title'), el.getAttribute('data-testid'), el.textContent]
      .join(' ');
    return /send|submit|отправ|➤|→/i.test(text);
  });
  if (labelled) {
    labelled.click();
    return { clicked: true };
  }

  // Icon-only send buttons (the common case) sit at the bottom-right of the
  // composer. Pick the closest one below/next to it.
  if (composerRect) {
    const nearby = buttons
      .filter((el) => {
        const rect = el.getBoundingClientRect();
        return rect.bottom >= composerRect.top - 8 && rect.right > composerRect.left + composerRect.width / 2;
      })
      .sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);
    if (nearby.length > 0) {
      nearby[0].click();
      return { clicked: true };
    }
  }

  return { clicked: false };
})()`;

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export async function broadcastPrompt(
  tabs: ServiceTab[],
  text: string,
  submit: boolean,
  tabIds?: string[]
): Promise<BroadcastResult[]> {
  const prompt = text.trim();
  if (!prompt) return [];

  const targets = tabIds?.length ? tabs.filter((tab) => tabIds.includes(tab.id)) : tabs;

  return Promise.all(targets.map(async (tab): Promise<BroadcastResult> => {
    const contents = contentsForTab(tab);
    if (!contents) return { tabId: tab.id, ok: false, reason: 'Page is not loaded' };

    try {
      const focused = await contents.executeJavaScript(focusComposerScript) as { ok?: boolean; reason?: string };
      if (!focused?.ok) {
        return { tabId: tab.id, ok: false, reason: focused?.reason ?? 'Message box not found' };
      }

      // insertText goes through the native input pipeline, so React/Vue/
      // ProseMirror see a normal edit instead of a synthetic DOM change.
      contents.focus();
      contents.insertText(prompt);
      await delay(180);

      if (!submit) return { tabId: tab.id, ok: true, submitted: false };

      const result = await contents.executeJavaScript(submitComposerScript) as { clicked?: boolean };
      if (!result?.clicked) {
        contents.sendInputEvent({ type: 'keyDown', keyCode: 'Return' });
        contents.sendInputEvent({ type: 'keyUp', keyCode: 'Return' });
      }
      return { tabId: tab.id, ok: true, submitted: true };
    } catch (error) {
      return {
        tabId: tab.id,
        ok: false,
        reason: error instanceof Error ? error.message : String(error)
      };
    }
  }));
}
