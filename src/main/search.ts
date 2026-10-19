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
 * Counts occurrences of `query` in the visible text of the page and returns a
 * short excerpt around the first one. This is intentionally done in the page
 * instead of `findInPage` so that hidden/background tabs can be searched too.
 */
function countScript(query: string): string {
  return `(() => {
  const needle = ${JSON.stringify(query)}.toLowerCase();
  if (!needle) return { count: 0, snippet: '' };

  const makeSnippet = (text, index) => {
    const start = Math.max(0, index - 70);
    const end = Math.min(text.length, index + needle.length + 70);
    return (start > 0 ? '…' : '') + text.slice(start, end).trim() + (end < text.length ? '…' : '');
  };

  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let node;
  let visited = 0;
  let count = 0;
  let fallback = '';
  let preferred = '';

  while ((node = walker.nextNode()) && visited++ < 40000) {
    const raw = node.nodeValue;
    if (!raw) continue;

    // Inline scripts/styles are text nodes too, but their contents are not
    // something the user can see or search for.
    const parentElement = node.parentElement;
    if (parentElement && parentElement.closest('script, style, noscript, template')) continue;

    const text = raw.replace(/\\s+/g, ' ').trim();
    if (text.length < 4) continue;
    const lower = text.toLowerCase();
    let index = lower.indexOf(needle);
    if (index === -1) continue;

    while (index !== -1 && count < ${MAX_COUNT}) {
      count++;
      index = lower.indexOf(needle, index + needle.length);
    }

    const parent = node.parentElement;
    const chrome = parent && parent.closest('nav, header, footer, button, a, [role="menu"], [role="navigation"]');
    if (!fallback) fallback = makeSnippet(text, lower.indexOf(needle));
    if (!preferred && !chrome && text.length >= 60) {
      preferred = makeSnippet(text, lower.indexOf(needle));
    }
  }

  return { count, snippet: preferred || fallback };
})()`;
}

export async function searchTabs(tabs: ServiceTab[], query: string): Promise<SearchHit[]> {
  const search = query.trim();
  if (search.length < 2) return [];

  const hits = await Promise.all(tabs.map(async (tab): Promise<SearchHit> => {
    const contents = contentsForTab(tab);
    if (!contents) return { tabId: tab.id, matches: 0 };
    try {
      const result = await contents.executeJavaScript(countScript(search)) as { count?: number; snippet?: string };
      return {
        tabId: tab.id,
        matches: result?.count ?? 0,
        snippet: result?.snippet || undefined
      };
    } catch {
      return { tabId: tab.id, matches: 0 };
    }
  }));

  stopAllFind(tabs);
  return hits;
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
