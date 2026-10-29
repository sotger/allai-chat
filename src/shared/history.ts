import type { ProviderId } from './types';

/**
 * One captured conversation. `titleOnly` entries come from the service's chat
 * list and have no body text yet; they are upgraded when the chat is opened.
 */
export interface HistoryEntry {
  id: string;
  tabId: string;
  providerId: ProviderId;
  service: string;
  url: string;
  title: string;
  text: string;
  capturedAt: number;
  titleOnly: boolean;
}

export interface HistoryHit {
  id: string;
  tabId: string;
  service: string;
  url: string;
  title: string;
  snippet: string;
  score: number;
  titleOnly: boolean;
  capturedAt: number;
}

export interface HistoryStats {
  entries: number;
  withText: number;
  /** Conversations known from a chat list that still have no captured text. */
  withoutText: number;
  characters: number;
  services: number;
}

/** Progress of the background indexer, streamed to the renderer. */
export interface HistoryProgress {
  running: boolean;
  service?: string;
  currentTitle?: string;
  done: number;
  total: number;
  error?: string;
  /** Position of the current service in a multi-service run. */
  batchIndex?: number;
  batchTotal?: number;
  /** Timestamp of the last finished run, for the "indexed N chats" note. */
  finishedAt?: number;
  /** Manual runs work through the whole queue; automatic ones are a top-up. */
  mode?: 'manual' | 'auto';
  /** Conversations without text when the run started (all services in scope). */
  queueInitial?: number;
  /** Conversations still without text, recomputed as the run goes. */
  queueRemaining?: number;
  /** Saved and failed counters for the whole run, not just the current service. */
  runSaved?: number;
  runFailed?: number;
  startedAt?: number;
}

/** One conversation that is known from a chat list but has no body text yet. */
export interface HistoryQueueItem {
  id: string;
  tabId: string;
  service: string;
  url: string;
  title: string;
  capturedAt: number;
}

/** The unindexed conversations of one service. */
export interface HistoryQueueGroup {
  tabId: string;
  service: string;
  providerId: ProviderId;
  color: string;
  icon: string;
  queued: number;
  items: HistoryQueueItem[];
  /** More rows exist than this snapshot carries. */
  truncated?: boolean;
}

export interface HistoryQueueSnapshot {
  groups: HistoryQueueGroup[];
  queued: number;
  withText: number;
  entries: number;
}

export interface HistoryRunFailure {
  title: string;
  url: string;
  /** Human-readable reason, shown in the report. */
  reason: string;
}

/** Per-service result inside a multi-service run. */
export interface HistorySummary {
  tabId: string;
  service: string;
  total: number;
  saved: number;
  failures: HistoryRunFailure[];
}

/** Summary shown when a background indexing run finishes. */
export interface HistoryReport {
  tabId: string;
  service: string;
  total: number;
  saved: number;
  failures: HistoryRunFailure[];
  startedAt: number;
  finishedAt: number;
  reason: 'manual' | 'auto';
  /** Every service touched by the run, in order. */
  services?: HistorySummary[];
  /** The run ended before the queue was empty (Stop, captcha, rate limit). */
  stopped?: boolean;
  /** Conversations in scope that still have no text when the run ended. */
  remaining?: number;
}

export interface HistoryEstimateService {
  tabId: string;
  service: string;
  candidates: number;
}

export interface HistoryEstimate {
  candidates: number;
  /** Rough duration in ms, based on load + settle + human pacing per chat. */
  estimatedMs: number;
  /** Per-service breakdown, so the dialog can say which services are covered. */
  services: HistoryEstimateService[];
}

/** A hit returned by a service's own search API (currently ChatGPT). */
export interface ServerSearchHit {
  tabId: string;
  service: string;
  title: string;
  snippet: string;
  url: string;
}

/** Collapses whitespace the same way the live page search does. */
export function normalizeText(value: string | undefined | null): string {
  return (value ?? '').replace(/\s+/g, ' ').trim();
}

/**
 * Chat lists contain navigation links whose visible text is not a chat title
 * ("Skip to main content" is the classic one). Such a title would otherwise end
 * up in the queue forever, because opening it does not produce a real chat.
 */
const NOISE_TITLES = [
  /^skip to (main )?content$/i,
  /^skip navigation$/i,
  /^main content$/i,
  /^toggle sidebar$/i,
  /^(open|close|hide|show) sidebar$/i,
  /^new chat$/i,
  /^new conversation$/i,
  /^start (a )?new chat$/i
];

export function cleanHistoryTitle(
  title: string | undefined | null,
  fallback = ''
): string {
  const normalized = normalizeText(title);
  if (!normalized) return fallback;
  if (NOISE_TITLES.some((pattern) => pattern.test(normalized))) return fallback;
  return normalized;
}

/** FNV-1a: short, stable, dependency-free id suffix. */
export function hashString(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

/**
 * URLs arrive with SPA noise (`?rid=…`, `#…`, trailing slashes). The entry id
 * must stay the same across those variants so re-visiting a chat updates the
 * existing row instead of creating duplicates.
 */
export function canonicalHistoryUrl(raw: string): string {
  try {
    const url = new URL(raw);
    url.hash = '';
    const host = url.hostname.toLowerCase();
    const path = url.pathname.replace(/\/+$/, '');
    const search = url.searchParams.get('q') ? `?q=${url.searchParams.get('q')}` : '';
    return `${url.protocol}//${host}${path}${search}`;
  } catch {
    return raw;
  }
}

export function historyId(tabId: string, url: string): string {
  return `${tabId}:${hashString(canonicalHistoryUrl(url))}`;
}

const AUTH_HOSTS = [
  'accounts.google.com',
  'accounts.youtube.com',
  'login.microsoftonline.com',
  'login.live.com',
  'appleid.apple.com',
  'github.com',
  'gitlab.com',
  'x.com',
  'twitter.com',
  'auth0.com',
  'okta.com',
  'clerk.com',
  'clerk.accounts.dev',
  'facebook.com',
  'linkedin.com',
  'discord.com',
  'slack.com'
];

function hostOf(raw: string): string | undefined {
  try {
    return new URL(raw).hostname.toLowerCase() || undefined;
  } catch {
    return undefined;
  }
}

/** Auth providers must never end up in the local history. */
export function isAuthUrl(raw: string): boolean {
  const host = hostOf(raw);
  if (!host) return false;
  if (host.includes('clerk')) return true;
  return AUTH_HOSTS.some((domain) => host === domain || host.endsWith(`.${domain}`));
}

export function isIndexableUrl(raw: string): boolean {
  if (!/^https?:\/\//i.test(raw)) return false;
  if (isAuthUrl(raw)) return false;
  const host = hostOf(raw);
  return Boolean(host);
}

const NON_CHAT_PATHS = [
  '/settings', '/pricing', '/login', '/logout', '/auth', '/signin', '/sign_in',
  '/sign-in', '/signup', '/register', '/help', '/about', '/terms', '/privacy',
  '/download', '/downloads', '/new', '/explore', '/discover', '/apps',
  '/plugins', '/projects', '/projects/new', '/chats', '/library', '/subscribe',
  '/history', '/recents', '/upgrade', '/account', '/billing'
];

/**
 * A known utility page ("/chats", "/library", "/subscribe", …) that must never
 * become a history row. Real conversations have an id segment in the path and
 * are not matched here.
 */
export function isUtilityUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    const path = url.pathname.toLowerCase();
    if (NON_CHAT_PATHS.some((known) => path === known || path.startsWith(`${known}/`))) return true;
    // Some services keep their account screens in the hash (`grok.com/#subscribe`).
    const hash = url.hash.toLowerCase();
    return /^#(subscribe|pricing|upgrade|settings|login|signin|signup|account|billing)/.test(hash);
  } catch {
    return false;
  }
}

const ACCESS_WALL_PATTERN = /you need access|request access|private conversation link|sign in to (continue|view)|log in to (continue|view)|access denied|^skip to main content\s+command menu/i;

/** A private/expired link or a sign-in wall is not a readable conversation. */
export function isAccessWallText(text: string | undefined | null): boolean {
  return ACCESS_WALL_PATTERN.test((text ?? '').slice(0, 1200));
}

/**
 * Identity of the conversation part of a URL. The *last* long id segment
 * matters: a ChatGPT project URL is
 * `/g/g-p-<project>/c/<chat>`, so taking the first id would treat every chat
 * in the project as the same conversation.
 */
export function chatKey(url: string): string | undefined {
  try {
    const segments = new URL(url).pathname.split('/').filter(Boolean);
    for (let index = segments.length - 1; index >= 0; index -= 1) {
      const segment = segments[index];
      if (/[0-9a-f]{8,}/i.test(segment) || /^\d{6,}$/.test(segment)) {
        return segment.toLowerCase();
      }
    }
  } catch { /* not a url */ }
  return undefined;
}

/**
 * Heuristic that works across services without per-site selectors: chat URLs
 * contain a long id (uuid, hex or numeric) and are not one of the known
 * utility pages.
 */
export function looksLikeChatUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    if (!/^https?:$/.test(url.protocol)) return false;
    const path = url.pathname.toLowerCase();
    if (path === '/' || path === '') return false;
    if (NON_CHAT_PATHS.some((known) => path === known || path.startsWith(`${known}/`))) return false;
    const segments = path.split('/').filter(Boolean);
    return segments.some((segment) => /[0-9a-f]{8,}/i.test(segment) || /^\d{6,}$/.test(segment));
  } catch {
    return false;
  }
}

export interface IndexCandidate {
  url: string;
  title: string;
}

/**
 * Builds the list a run will read: freshly harvested links first, then the
 * conversations that are already in the local queue. The second half matters:
 * older chats and ChatGPT project conversations are often no longer present in
 * the visible sidebar, and re-harvesting the list would never reach them.
 */
export function mergeIndexQueue(
  harvested: readonly IndexCandidate[],
  queued: readonly IndexCandidate[],
  limit: number
): IndexCandidate[] {
  const candidates: IndexCandidate[] = [];
  const seen = new Set<string>();
  const seenChats = new Set<string>();
  for (const link of [...harvested, ...queued]) {
    if (!looksLikeChatUrl(link.url)) continue;
    const key = canonicalHistoryUrl(link.url);
    if (seen.has(key)) continue;
    // The same chat can appear under a short and a slugged project URL.
    // `chatKey` collapses those variants so a run does not read them twice.
    const chat = chatKey(link.url);
    if (chat && seenChats.has(chat)) continue;
    seen.add(key);
    if (chat) seenChats.add(chat);
    candidates.push({ url: link.url, title: normalizeText(link.title) });
    if (candidates.length >= Math.max(1, limit)) break;
  }
  return candidates;
}

/**
 * Keeps the richest copy of a conversation. A partial render must never replace
 * a complete capture, and a title-only row is upgraded by a real capture.
 */export function mergeHistoryEntry(previous: HistoryEntry | undefined, next: HistoryEntry): HistoryEntry {
  if (!previous) return next;

  const previousText = normalizeText(previous.text);
  const nextText = normalizeText(next.text);
  // Ignore a much shorter re-render (skeleton screens, lazy lists).
  const keepPreviousText = previousText.length > 0
    && nextText.length < previousText.length * 0.6;
  const text = keepPreviousText || nextText.length === 0
    ? previous.text
    : next.text;
  const titleOnly = text.trim().length === 0;
  const title = normalizeText(next.title) || previous.title;

  return {
    ...previous,
    ...next,
    title,
    text,
    titleOnly,
    capturedAt: text && text !== previous.text ? next.capturedAt : previous.capturedAt
  };
}

/** mm:ss (or h:mm:ss) for dialogs and reports. */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours > 0) return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

/** Approximate on-disk size of the stored text, for the settings summary. */
export function historyStats(entries: Iterable<HistoryEntry>): HistoryStats {
  let withText = 0;
  let characters = 0;
  const services = new Set<string>();
  let count = 0;
  for (const entry of entries) {
    count += 1;
    services.add(entry.tabId);
    characters += entry.text.length;
    if (entry.text.trim()) withText += 1;
  }
  return { entries: count, withText, withoutText: count - withText, characters, services: services.size };
}
