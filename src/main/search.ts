import { session, webContents, type WebContents } from 'electron';
import type { SearchHit } from '@shared/ipc';
import type { ServiceTab } from '@shared/types';

const MAX_COUNT = 500;

export function contentsForTab(tab: ServiceTab): WebContents | undefined {
  const tabSession = session.fromPartition(tab.partition);
  return webContents.getAllWebContents().find((contents) =>
    contents.getType() === 'webview' && !contents.isDestroyed() && contents.session === tabSession
  );
}

/**
 * Counts occurrences of `query` in the rendered text of the page and returns a
 * short excerpt around the first one.
 *
 * The page text is collected with `innerText`, not by walking individual text
 * nodes. Chat UIs routinely split a phrase across inline elements (for example
 * "Ctrl" + "+" + "Space"), and node-by-node matching silently misses those.
 * `innerText` joins inline runs without separators and inserts newlines between
 * blocks, which is exactly the text a user sees.
 *
 * Matches that only exist in navigation/aside text (the chat list of a service)
 * are flagged with `inList`, so the UI can tell a real page match from a chat
 * title and open that chat instead of pretending the text is on screen.
 */
function searchScript(query: string): string {
  return `(() => {
  const needle = ${JSON.stringify(query)}.toLowerCase();
  if (!needle) return { count: 0, snippet: '', inList: false, scanned: 0 };

  const normalize = (value) => (value || '').replace(/\\s+/g, ' ').trim();
  const listSelector = 'nav, aside, header, [role="navigation"], [role="menu"], [role="complementary"]';

  let text = normalize(document.body ? document.body.innerText : '');
  let scanned = text.length;

  // innerText ignores shadow roots. They mostly hold widgets, but if a
  // service puts chat text there we still want to search it.
  for (const host of document.querySelectorAll('*')) {
    if (!host.shadowRoot) continue;
    const shadow = normalize(host.shadowRoot.textContent);
    if (!shadow) continue;
    text += ' ' + shadow;
    scanned += shadow.length;
  }

  const lower = text.toLowerCase();
  let index = lower.indexOf(needle);
  if (index === -1) return { count: 0, snippet: '', inList: false, scanned };

  const first = index;
  let count = 0;
  while (index !== -1 && count < ${MAX_COUNT}) {
    count++;
    index = lower.indexOf(needle, index + needle.length);
  }

  // Chat lists and sidebars are also part of body text. Count the matches that
  // live there separately: when every match comes from a list, the hit is a
  // chat title, not text that is currently rendered in a conversation.
  let listCount = 0;
  for (const element of document.querySelectorAll(listSelector)) {
    if (element.closest('script, style, noscript, template')) continue;
    const listText = normalize(element.innerText).toLowerCase();
    let listIndex = listText.indexOf(needle);
    while (listIndex !== -1 && listCount < ${MAX_COUNT}) {
      listCount++;
      listIndex = listText.indexOf(needle, listIndex + needle.length);
    }
  }
  const inList = count > 0 && listCount >= count;

  const start = Math.max(0, first - 90);
  const end = Math.min(text.length, first + needle.length + 90);
  const snippet = (start > 0 ? '…' : '') + text.slice(start, end).trim() + (end < text.length ? '…' : '');

  return { count, snippet, inList, scanned };
})()`;
}

/**
 * Clicks the matching chat in the service's own sidebar.
 *
 * Prefer real links and buttons whose visible text or aria-label contains the
 * query — a plain `.click()` on those is enough. Several services wrap the row
 * in an absolutely positioned `<a aria-label="…">` with no text, so the aria
 * label matters. When nothing clickable can be identified, fall back to a
 * trusted mouse click at the text position.
 */
function clickListResultScript(query: string): string {
  return `(() => {
  const needle = ${JSON.stringify(query)}.toLowerCase();
  const normalize = (value) => (value || '').replace(/\\s+/g, ' ').trim();
  const listSelector = 'nav, aside, header, [role="navigation"], [role="menu"], [role="complementary"]';
  const selector = 'a[href], button, [role="button"], [role="link"], li[tabindex], [tabindex]';

  const candidates = [];
  for (const element of document.querySelectorAll(selector)) {
    const text = normalize(element.innerText + ' ' + (element.getAttribute('aria-label') || '')).toLowerCase();
    if (!text.includes(needle)) continue;
    const inList = Boolean(element.closest(listSelector));
    candidates.push({ element, result: element.tagName === 'A' && element.getAttribute('href') ? 0 : 1, score: text.length, inList });
  }
  candidates.sort((a, b) => (b.inList - a.inList) || (a.result - b.result) || (a.score - b.score));
  if (candidates.length > 0) {
    const target = candidates[0].element;
    target.scrollIntoView({ block: 'center', inline: 'nearest' });
    target.click();
    return true;
  }

  // Last resort: find the visible text and click the element under it.
  const leaves = [...document.querySelectorAll('body *')].filter((element) =>
    !element.children.length && normalize(element.textContent).toLowerCase().includes(needle)
  );
  const leaf = leaves.find((element) => {
    const rect = element.getBoundingClientRect();
    return rect.width > 2 && rect.height > 2;
  });
  if (!leaf) return false;
  const rect = leaf.getBoundingClientRect();
  const point = document.elementFromPoint(rect.left + Math.min(rect.width / 2, 40), rect.top + rect.height / 2);
  (point || leaf).click();
  return true;
})()`;
}

/** Coordinates of the matching list row, used for a trusted mouse click. */
function locateListResultScript(query: string): string {
  return `(() => {
  const needle = ${JSON.stringify(query)}.toLowerCase();
  const normalize = (value) => (value || '').replace(/\\s+/g, ' ').trim();
  const leaves = [...document.querySelectorAll('body *')].filter((element) =>
    !element.children.length && normalize(element.textContent).toLowerCase().includes(needle)
  );
  for (const leaf of leaves) {
    const rect = leaf.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) continue;
    leaf.scrollIntoView({ block: 'center', inline: 'nearest' });
    const next = leaf.getBoundingClientRect();
    return { ok: true, x: Math.round(next.left + Math.min(next.width / 2, 40)), y: Math.round(next.top + next.height / 2) };
  }
  return { ok: false };
})()`;
}

export async function searchTabs(tabs: ServiceTab[], query: string): Promise<SearchHit[]> {
  const search = query.trim();
  if (search.length < 2) return [];

  const hits = await Promise.all(tabs.map(async (tab): Promise<SearchHit> => {
    const contents = contentsForTab(tab);
    if (!contents) return { tabId: tab.id, matches: 0, scanned: 0 };
    try {
      const result = await contents.executeJavaScript(searchScript(search)) as {
        count?: number;
        snippet?: string;
        inList?: boolean;
        scanned?: number;
      };
      return {
        tabId: tab.id,
        matches: result?.count ?? 0,
        snippet: result?.snippet || undefined,
        inList: Boolean(result?.inList),
        scanned: result?.scanned ?? 0
      };
    } catch {
      return { tabId: tab.id, matches: 0, scanned: 0 };
    }
  }));

  stopAllFind(tabs);
  return hits;
}

/**
 * Jumps to a search hit. List-only hits first click the matching chat in the
 * service sidebar, because the phrase is a chat title and the conversation is
 * not loaded yet.
 */
export async function openSearchResult(
  tabs: ServiceTab[],
  tabId: string,
  query: string,
  inList: boolean
): Promise<number> {
  const tab = tabs.find((item) => item.id === tabId);
  const contents = tab ? contentsForTab(tab) : undefined;
  if (!contents) return 0;

  if (inList) {
    const before = contents.getURL();
    try {
      const clicked = await contents.executeJavaScript(clickListResultScript(query.trim())) as boolean;
      if (!clicked) {
        const located = await contents.executeJavaScript(locateListResultScript(query.trim())) as {
          ok?: boolean;
          x?: number;
          y?: number;
        };
        if (located?.ok && typeof located.x === 'number' && typeof located.y === 'number') {
          contents.sendInputEvent({ type: 'mouseDown', x: located.x, y: located.y, button: 'left', clickCount: 1 });
          contents.sendInputEvent({ type: 'mouseUp', x: located.x, y: located.y, button: 'left', clickCount: 1 });
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 1400));
      if (contents.getURL() === before) {
        await contents.executeJavaScript(clickListResultScript(query.trim())).catch(() => undefined);
        await new Promise((resolve) => setTimeout(resolve, 1200));
      }
    } catch { /* fall through to findInPage */ }
  }

  return findInTab(tabs, tabId, query, { forward: true });
}

export function stopAllFind(tabs: ServiceTab[]): void {
  for (const tab of tabs) {
    try {
      contentsForTab(tab)?.stopFindInPage('clearSelection');
    } catch { /* ignore */ }
  }
}

export function findInTab(
  tabs: ServiceTab[],
  tabId: string,
  query: string,
  options?: { forward?: boolean; findNext?: boolean }
): number {
  const tab = tabs.find((item) => item.id === tabId);
  const contents = tab ? contentsForTab(tab) : undefined;
  if (!contents) return 0;
  try {
    return contents.findInPage(query, {
      forward: options?.forward ?? true,
      findNext: options?.findNext ?? false
    });
  } catch {
    return 0;
  }
}
