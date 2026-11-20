import { getProviderConfig } from '@shared/providers';
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

/**
 * Clicks the service's own "New chat" control. Site-agnostic: match the
 * accessible label, which every chat UI provides for its icon-only button.
 * Prefer a link that points at a new/root address over a plain button.
 */
const newChatScript = `(() => {
  const norm = (value) => (value || '').replace(/\\s+/g, ' ').trim();
  const labels = /^(new chat|new conversation|new thread|new session|start (a )?new chat|start (a )?new conversation|compose|новый чат|новый диалог|новая беседа|создать чат|新建对话|新对话|新建聊天|开启新对话)$/i;

  const visible = (el) => {
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
  };

  const candidates = [...document.querySelectorAll('a[href], button, [role="button"], [role="link"]')]
    .filter((el) => !el.disabled && el.getAttribute('aria-disabled') !== 'true' && visible(el))
    .map((el) => {
      const text = norm(el.getAttribute('aria-label') || el.getAttribute('title') || el.innerText || '');
      const testId = (el.getAttribute('data-testid') || '').toLowerCase();
      return { el, text, testId };
    })
    .filter((item) => {
      if (/new[-_ ]?chat|new[-_ ]?conversation/.test(item.testId)) return true;
      if (labels.test(item.text)) return true;
      // Some labels append a keyboard shortcut ("New chat Ctrl+Shift+O").
      return /^(new chat|new conversation|new thread|новый чат|新建对话|新对话)\\b/i.test(item.text)
        && item.text.length < 40;
    })
    // A history entry can be titled "New chat"; its href points at a concrete
    // conversation, so it must never be mistaken for the button.
    .filter((item) => {
      if (item.el.tagName !== 'A') return true;
      try {
        const path = new URL(item.el.href, location.href).pathname;
        return !/(^|\\/)[0-9a-f]{8,}/i.test(path) && !/(^|\\/)\\d{6,}(\\/|$)/.test(path);
      } catch { return true; }
    });

  if (candidates.length === 0) return { clicked: false };

  const isNewAddress = (item) => {
    if (item.el.tagName !== 'A') return false;
    try {
      const path = new URL(item.el.href, location.href).pathname.replace(/\\/+$/, '');
      return path === '' || /\\/(new|chat|conversation)$/i.test(path);
    } catch { return false; }
  };

  const target = candidates.find(isNewAddress) ?? candidates[0];
  target.el.click();
  return { clicked: true };
})()`;

/** Clicks the send button next to the composer, if one can be identified. */
function submitComposerScript(click: boolean): string {
  return `(() => {
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

  // Icon-only send buttons (the common case) sit at the bottom-right of the
  // composer. Pick the closest one below/next to it.
  let nearby = null;
  if (!labelled && composerRect) {
    nearby = buttons
      .filter((el) => {
        const rect = el.getBoundingClientRect();
        return rect.bottom >= composerRect.top - 8 && rect.right > composerRect.left + composerRect.width / 2;
      })
      .sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top)[0] ?? null;
  }

  const target = labelled ?? nearby;
  if (!target) return { found: false, clicked: false };
  if (${click ? 'true' : 'false'}) target.click();
  return { found: true, clicked: ${click ? 'true' : 'false'} };
})()`;
}

const probeSendScript = submitComposerScript(false);
const clickSendScript = submitComposerScript(true);

/**
 * Reads the composer and the page text in one round-trip. The page length is a
 * generic way to notice that the message bubble appeared even on services that
 * keep the text in the composer after sending.
 */
const composerSnapshotScript = `(() => {
  const composer = window.__allaiComposer;
  const value = composer && composer.isConnected
    ? (composer.isContentEditable ? composer.innerText : (typeof composer.value === 'string' ? composer.value : ''))
    : null;
  const main = document.querySelector('main, [role="main"]') || document.body;
  return { value, textLength: main && typeof main.innerText === 'string' ? main.innerText.length : 0 };
})()`;

interface ComposerSnapshot {
  value: string | null;
  textLength: number;
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  return Promise.race([
    promise.catch(() => undefined),
    new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), ms))
  ]);
}

/**
 * After "New chat" is clicked, wait for the SPA route to change (most services)
 * or for the list to re-render in place (a few keep the same URL until the
 * first message is sent).
 */
async function waitForNewConversation(contents: Electron.WebContents, beforeUrl: string): Promise<boolean> {
  const deadline = Date.now() + 3500;
  while (Date.now() < deadline) {
    await delay(200);
    if (contents.isDestroyed()) return false;
    if (contents.getURL() !== beforeUrl) {
      if (!contents.isLoading()) {
        // SPA route change: the composer is often re-mounted one tick later.
        await delay(350);
        return true;
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 12_000);
        contents.once('did-stop-loading', () => {
          clearTimeout(timer);
          resolve();
        });
      });
      return true;
    }
  }
  // Same URL: give the page a moment to clear the conversation.
  await delay(600);
  return false;
}

/** The composer may be disabled or re-mounted while a new chat renders. */
async function focusComposer(
  contents: Electron.WebContents,
  timeoutMs = 8000
): Promise<{ ok?: boolean; reason?: string }> {
  const deadline = Date.now() + timeoutMs;
  let last: { ok?: boolean; reason?: string } | undefined;
  while (Date.now() < deadline) {
    if (contents.isDestroyed()) return { ok: false, reason: 'Page was closed' };
    last = await contents.executeJavaScript(focusComposerScript)
      .catch(() => ({ ok: false, reason: 'Page is not ready' })) as { ok?: boolean; reason?: string };
    if (last?.ok) return last;
    await delay(400);
  }
  return last ?? { ok: false, reason: 'Message box not found' };
}

async function readSnapshot(contents: Electron.WebContents): Promise<ComposerSnapshot | undefined> {
  const result = await contents.executeJavaScript(composerSnapshotScript)
    .catch(() => undefined) as ComposerSnapshot | undefined;
  if (!result || typeof result.textLength !== 'number') return undefined;
  return {
    value: typeof result.value === 'string' || result.value === null ? result.value : '',
    textLength: result.textLength
  };
}

/**
 * Waits for an enabled send control. It appears a moment after the composer
 * receives its first characters, and some services keep it disabled until the
 * editor's own state catches up.
 */
async function waitForSendButton(contents: Electron.WebContents, timeoutMs = 2500): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (contents.isDestroyed()) return false;
    const state = await contents.executeJavaScript(probeSendScript)
      .catch(() => undefined) as { found?: boolean } | undefined;
    if (state?.found) return true;
    await delay(200);
  }
  return false;
}

function pressReturn(contents: Electron.WebContents): void {
  contents.sendInputEvent({ type: 'keyDown', keyCode: 'Return' });
  contents.sendInputEvent({ type: 'keyUp', keyCode: 'Return' });
}

function composerStillHasPrompt(snapshot: ComposerSnapshot, prompt: string): boolean {
  if (snapshot.value === null) return false;
  if (snapshot.value.trim().length === 0) return false;
  return snapshot.value.includes(prompt.slice(0, 40));
}

/**
 * Clicks the send control, verifies the result and falls back to the keyboard
 * once. The composer is re-read instead of trusting the click: some services
 * ignore a programmatic click until the tab is visible or the editor is ready.
 */
async function submitWithVerification(contents: Electron.WebContents, prompt: string): Promise<boolean> {
  if (contents.isDestroyed()) return false;
  const before = await readSnapshot(contents);

  await contents.executeJavaScript(focusComposerScript).catch(() => undefined);
  contents.focus();

  const hadButton = await waitForSendButton(contents);
  if (hadButton) {
    await contents.executeJavaScript(clickSendScript).catch(() => undefined);
    await delay(1000);

    const afterClick = await readSnapshot(contents);
    if (!afterClick) {
      // The page navigated or the composer was replaced: treat it as sent.
      return true;
    }
    if (!composerStillHasPrompt(afterClick, prompt)) return true;
    if (before && afterClick.textLength > before.textLength + 20) return true;
  }

  // No button, or the click did not produce a message. A native Return is the
  // trusted input path most services use for "send"; it is tried once to avoid
  // sending the same prompt twice.
  await contents.executeJavaScript(focusComposerScript).catch(() => undefined);
  contents.focus();
  pressReturn(contents);
  await delay(1200);

  const afterReturn = await readSnapshot(contents);
  if (!afterReturn) return true;
  if (!composerStillHasPrompt(afterReturn, prompt)) return true;
  if (before && afterReturn.textLength > before.textLength + 20) return true;
  return false;
}

export interface BroadcastActivation {
  /** Makes a tab visible and focused in the renderer for the submit step. */
  activate: (tabId: string) => void;
  /** The tab that was active before the broadcast, restored at the end. */
  originalTabId?: string | null;
}

/**
 * Starts a fresh conversation before the text is inserted. Clicking the site's
 * own control is preferred (it keeps SPA state); navigating to the provider's
 * known "new chat" address is the fallback. Custom services have no known
 * address, so they fail loudly instead of posting into an existing chat.
 */
async function startNewChat(
  contents: Electron.WebContents,
  tab: ServiceTab
): Promise<{ ok: boolean; reason?: string }> {
  const beforeUrl = contents.getURL();
  const clicked = await withTimeout(
    contents.executeJavaScript(newChatScript) as Promise<{ clicked?: boolean }>,
    4000
  );
  const config = getProviderConfig(tab.providerId);

  if (clicked?.clicked) {
    const navigated = await waitForNewConversation(contents, beforeUrl);
    // The label matched but the page kept the same conversation (a mis-click
    // on a history row, or an SPA that needs a route change). Navigate to the
    // provider's known new-chat address rather than posting into the old chat.
    if (!navigated && config.newChatUrl) {
      const loaded = await loadWithTimeout(contents, config.newChatUrl, 20_000);
      if (!loaded) return { ok: false, reason: 'Could not open a new conversation' };
      await delay(500);
    }
    return { ok: true };
  }

  if (config.newChatUrl) {
    const loaded = await loadWithTimeout(contents, config.newChatUrl, 20_000);
    if (loaded) {
      await delay(500);
      return { ok: true };
    }
    return { ok: false, reason: 'Could not open a new conversation' };
  }

  return { ok: false, reason: 'New chat button not found' };
}

async function loadWithTimeout(
  contents: Electron.WebContents,
  url: string,
  timeoutMs: number
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
  });
  const load = contents.loadURL(url).then(() => true).catch(() => false);
  const result = await Promise.race([load, timeout]);
  if (timer) clearTimeout(timer);
  return result;
}

interface PreparedBroadcast {
  tab: ServiceTab;
  result: BroadcastResult;
  /** The prompt is in the composer and the tab can be submitted. */
  ready: boolean;
}

export async function broadcastPrompt(
  tabs: ServiceTab[],
  text: string,
  submit: boolean,
  tabIds?: string[],
  newChat = true,
  activation?: BroadcastActivation
): Promise<BroadcastResult[]> {
  const prompt = text.trim();
  if (!prompt) return [];

  const targets = tabIds?.length ? tabs.filter((tab) => tabIds.includes(tab.id)) : tabs;

  // Phase 1: create the new chat and insert the text in every tab. This works
  // while the tabs are in the background, so the app does not have to flash
  // through them just to type.
  const prepared = await Promise.all(targets.map(async (tab): Promise<PreparedBroadcast> => {
    const contents = contentsForTab(tab);
    if (!contents) {
      return { tab, result: { tabId: tab.id, ok: false, reason: 'Page is not loaded' }, ready: false };
    }

    try {
      let startedNewChat = false;
      if (newChat) {
        const started = await startNewChat(contents, tab);
        if (!started.ok) {
          return {
            tab,
            result: {
              tabId: tab.id,
              ok: false,
              reason: started.reason ?? 'Could not start a new chat'
            },
            ready: false
          };
        }
        startedNewChat = true;
      }

      const focused = await focusComposer(contents);
      if (!focused?.ok) {
        return {
          tab,
          result: {
            tabId: tab.id,
            ok: false,
            reason: focused?.reason ?? 'Message box not found',
            startedNewChat
          },
          ready: false
        };
      }

      // insertText goes through the native input pipeline, so React/Vue/
      // ProseMirror see a normal edit instead of a synthetic DOM change.
      contents.focus();
      contents.insertText(prompt);
      await delay(180);

      return {
        tab,
        result: { tabId: tab.id, ok: true, submitted: false, startedNewChat },
        ready: true
      };
    } catch (error) {
      return {
        tab,
        result: {
          tabId: tab.id,
          ok: false,
          reason: error instanceof Error ? error.message : String(error)
        },
        ready: false
      };
    }
  }));

  if (!submit) return prepared.map((item) => item.result);

  // Phase 2: submit one tab at a time, making each tab the visible/focused one
  // first. Gemini and DeepSeek both ignore a background click or keep the send
  // button disabled until their tab is active. The previous tab is restored.
  for (const item of prepared) {
    if (!item.ready) continue;

    const contents = contentsForTab(item.tab);
    if (!contents) {
      item.result = { ...item.result, reason: 'Page disappeared before sending' };
      continue;
    }

    if (activation) {
      activation.activate(item.tab.id);
      await delay(500);
      contents.focus();
    }

    try {
      const sent = await submitWithVerification(contents, prompt);
      item.result = sent
        ? { ...item.result, submitted: true }
        : {
          ...item.result,
          submitted: false,
          reason: 'send button did not respond — press Enter in the tab'
        };
    } catch (error) {
      item.result = {
        ...item.result,
        submitted: false,
        reason: error instanceof Error ? error.message : String(error)
      };
    }
    await delay(200);
  }

  if (activation?.originalTabId) activation.activate(activation.originalTabId);
  return prepared.map((item) => item.result);
}
