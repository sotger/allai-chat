import type { WebContents } from 'electron';

import {
  canonicalHistoryUrl,
  cleanHistoryTitle,
  historyId,
  isIndexableUrl,
  normalizeText,
  type HistoryEntry
} from '@shared/history';
import type { ServiceTab } from '@shared/types';

const MAX_CAPTURE_CHARS = 120_000;

/** Reads the rendered text of the page. Shadow roots are appended separately. */
export const captureScript = `(() => {
  const norm = (value) => (value || '').replace(/\\s+/g, ' ').trim();
  const noise = 'nav, aside, header, footer, [role="navigation"], [role="complementary"], [role="banner"], [role="contentinfo"], [class*="sidebar" i], [class*="side-bar" i]';

  // The sidebar holds the chat list, not the conversation. Hide it for the
  // duration of one synchronous read: innerText keeps block boundaries (unlike
  // textContent on a clone) and the paint happens after the style is removed,
  // so nothing flickers.
  const style = document.createElement('style');
  style.textContent = noise + ' { display: none !important; }';
  (document.head || document.documentElement).appendChild(style);
  let text = document.body ? document.body.innerText : '';
  style.remove();
  if (!text.trim() && document.body) text = document.body.innerText;

  for (const host of document.querySelectorAll('*')) {
    if (!host.shadowRoot) continue;
    const shadow = host.shadowRoot.textContent;
    if (shadow) text += ' ' + shadow;
  }
  return {
    url: location.href,
    title: norm(document.title),
    text: norm(text).slice(0, ${MAX_CAPTURE_CHARS})
  };
})()`;

/**
 * Collects conversation links from the service's own sidebar. The heuristics
 * are intentionally site-agnostic: same origin, a chat-like path (long id
 * segment) or a link inside navigation with visible text.
 */
export function harvestScript(options: { scroll?: boolean } = {}): string {
  const { scroll = false } = options;
  return `(async () => {
  const norm = (value) => (value || '').replace(/\\s+/g, ' ').trim();
  const skip = /\\/(settings|pricing|login|logout|auth|signin|signup|register|help|about|terms|privacy|downloads?|new|explore|discover|apps|plugins|projects\\/new)(\\/|$)/i;
  const found = new Map();

  const collect = () => {
    for (const anchor of document.querySelectorAll('a[href]')) {
      let url;
      try { url = new URL(anchor.href, location.href); } catch { continue; }
      if (url.origin !== location.origin) continue;
      if (skip.test(url.pathname)) continue;
      const title = norm(anchor.getAttribute('aria-label') || anchor.innerText || '');
      if (title.length < 2 || title.length > 200) continue;
      const segments = url.pathname.split('/').filter(Boolean);
      const idLike = segments.some((segment) => /[0-9a-f]{8,}/i.test(segment) || /^\\d{6,}$/.test(segment));
      // Navigation rows without an id in the path are accepted only when they
      // sit in a real list (a chat list has many sibling links; "Projects" and
      // "Settings" do not).
      let listLike = false;
      const container = anchor.closest('ul, ol, nav, aside, [role="list"], [role="navigation"]');
      if (container) listLike = container.querySelectorAll('a[href]').length >= 5;
      if (!idLike && !listLike) continue;
      url.hash = '';
      const key = url.href.replace(/\\/+$/, '');
      if (!found.has(key)) found.set(key, { url: key, title });
    }
  };

  collect();

  if (${scroll ? 'true' : 'false'}) {
    // Load more history rows by scrolling the tallest sidebar container.
    const roots = [...document.querySelectorAll('nav, aside, [role="navigation"], [role="complementary"]')];
    let scroller = null;
    let best = 0;
    for (const root of roots) {
      for (const element of [root, ...root.querySelectorAll('*')]) {
        const range = element.scrollHeight - element.clientHeight;
        if (range > best && element.clientHeight > 200) { best = range; scroller = element; }
      }
    }
    if (scroller) {
      for (let step = 0; step < 6; step++) {
        scroller.scrollTop = scroller.scrollHeight;
        await new Promise((resolve) => setTimeout(resolve, 700));
        collect();
      }
      scroller.scrollTop = 0;
    }
  }

  const here = norm(document.title);
  if (here) {
    const key = location.href.split('#')[0].replace(/\\/+$/, '');
    const segments = new URL(key).pathname.split('/').filter(Boolean);
    const idLike = segments.some((segment) => /[0-9a-f]{8,}/i.test(segment) || /^\\d{6,}$/.test(segment));
    if (idLike && !found.has(key)) found.set(key, { url: key, title: here });
  }

  return [...found.values()].slice(0, 500);
})()`;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  return Promise.race([
    promise.catch(() => undefined),
    new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), ms))
  ]);
}

export interface CapturedPage {
  url: string;
  title: string;
  text: string;
}

export async function capturePage(contents: WebContents, timeoutMs = 4000): Promise<CapturedPage | undefined> {
  if (contents.isDestroyed()) return undefined;
  const result = await withTimeout(
    contents.executeJavaScript(captureScript) as Promise<CapturedPage>,
    timeoutMs
  );
  if (!result?.url) return undefined;
  return {
    url: result.url,
    title: normalizeText(result.title),
    text: normalizeText(result.text)
  };
}

export function toHistoryEntry(tab: ServiceTab, page: CapturedPage, now = Date.now()): HistoryEntry | undefined {
  if (!isIndexableUrl(page.url)) return undefined;
  const text = page.text.slice(0, MAX_CAPTURE_CHARS);
  if (text.length < 40) return undefined;
  return {
    id: historyId(tab.id, page.url),
    tabId: tab.id,
    providerId: tab.providerId,
    service: tab.label,
    url: page.url,
    title: cleanHistoryTitle(page.title, tab.label),
    text,
    capturedAt: now,
    titleOnly: false
  };
}

/** `toHistoryEntry` uses the canonical URL as the id suffix via historyId. */
export function titleEntry(tab: ServiceTab, url: string, title: string, now = Date.now()): HistoryEntry | undefined {
  if (!isIndexableUrl(url)) return undefined;
  return {
    id: historyId(tab.id, url),
    tabId: tab.id,
    providerId: tab.providerId,
    service: tab.label,
    url,
    title: cleanHistoryTitle(title, tab.label),
    text: '',
    capturedAt: now,
    titleOnly: true
  };
}

export interface HarvestedLink {
  url: string;
  title: string;
}

export async function harvestTitles(
  contents: WebContents,
  options: { deep?: boolean; timeoutMs?: number } = {}
): Promise<HarvestedLink[]> {
  if (contents.isDestroyed()) return [];
  const links = await withTimeout(
    contents.executeJavaScript(harvestScript({ scroll: options.deep })) as Promise<HarvestedLink[]>,
    options.timeoutMs ?? (options.deep ? 25_000 : 8_000)
  );
  if (!Array.isArray(links)) return [];
  const seen = new Set<string>();
  const cleaned: HarvestedLink[] = [];
  for (const link of links) {
    if (!link?.url || !isIndexableUrl(link.url)) continue;
    // Navigation rows ("Skip to main content") are not conversations and must
    // not enter the queue: opening them never produces readable text.
    const title = cleanHistoryTitle(link.title);
    if (!title) continue;
    const key = canonicalHistoryUrl(link.url);
    if (seen.has(key)) continue;
    seen.add(key);
    cleaned.push({ url: link.url, title });
  }
  return cleaned;
}
