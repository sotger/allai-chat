import type { WebContents } from 'electron';

import { normalizeText, type ServerSearchHit } from '@shared/history';

const TOKEN_TTL_MS = 20 * 60 * 1000;
const MAX_RESULTS = 15;

interface CachedToken {
  token: string;
  at: number;
}

const tokenCache = new WeakMap<WebContents, CachedToken>();

export function isChatGptUrl(raw: string): boolean {
  try {
    const host = new URL(raw).hostname;
    return host === 'chatgpt.com' || host.endsWith('.chatgpt.com') || host === 'chat.openai.com';
  } catch {
    return false;
  }
}

function searchScript(query: string, token: string | null): string {
  return `(async () => {
  try {
    let accessToken = ${JSON.stringify(token)};
    if (!accessToken) {
      const session = await fetch('/api/auth/session', { credentials: 'include' }).then((r) => r.json());
      accessToken = session && session.accessToken;
    }
    if (!accessToken) return { status: 401, items: [] };

    const response = await fetch('/backend-api/global/search', {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + accessToken },
      body: JSON.stringify({
        entrypoint: 'global_search',
        limit: ${MAX_RESULTS},
        query: ${JSON.stringify(query)},
        source_requests: [{ type: 'conversation' }],
        cursor: null,
        query_id: crypto.randomUUID()
      })
    });
    if (response.status === 401) return { status: 401, items: [] };
    if (!response.ok) return { status: response.status, items: [] };
    const data = await response.json();
    return { status: 200, token: accessToken, items: Array.isArray(data.items) ? data.items : [] };
  } catch (error) {
    return { status: 0, items: [], error: String(error) };
  }
})()`;
}

function conversationUrl(id: unknown): string | undefined {
  if (typeof id !== 'string') return undefined;
  const match = /^conversation:([0-9a-f-]{36})/i.exec(id);
  return match ? `https://chatgpt.com/c/${match[1]}` : undefined;
}

/**
 * ChatGPT keeps a server-side full-text index of every conversation, including
 * ones the app has never opened. The endpoint is undocumented, so it is treated
 * as an optional accelerator: any failure returns an empty list and the local
 * index still answers.
 */
export async function searchChatGpt(contents: WebContents, query: string, tabId: string): Promise<ServerSearchHit[]> {
  const search = query.trim();
  if (search.length < 2 || contents.isDestroyed() || !isChatGptUrl(contents.getURL())) return [];

  const cached = tokenCache.get(contents);
  const token = cached && Date.now() - cached.at < TOKEN_TTL_MS ? cached.token : null;

  const attempt = async (withToken: string | null): Promise<{ status: number; token?: string; items: unknown[] }> => {
    const result = await Promise.race([
      contents.executeJavaScript(searchScript(search, withToken)) as Promise<{ status: number; token?: string; items: unknown[] }>,
      new Promise<{ status: number; token?: string; items: unknown[] }>((resolve) => setTimeout(() => resolve({ status: 0, items: [] }), 8000))
    ]);
    return result ?? { status: 0, items: [] };
  };

  let result = await attempt(token);
  if (result.status === 401) {
    tokenCache.delete(contents);
    result = await attempt(null);
  }
  if (result.status !== 200) return [];

  if (result.token) tokenCache.set(contents, { token: result.token, at: Date.now() });

  const hits: ServerSearchHit[] = [];
  for (const item of result.items as Array<Record<string, unknown>>) {
    if (!item || item.source_type !== 'conversation') continue;
    const url = conversationUrl(item.id);
    if (!url) continue;
    hits.push({
      tabId,
      service: 'ChatGPT',
      title: normalizeText(String(item.title ?? '')) || 'ChatGPT conversation',
      snippet: normalizeText(String(item.snippet ?? '')).slice(0, 400),
      url
    });
    if (hits.length >= MAX_RESULTS) break;
  }
  return hits;
}
