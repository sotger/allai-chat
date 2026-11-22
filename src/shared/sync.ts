import { canonicalHistoryUrl, normalizeText, type HistoryEntry } from './history';
import type { ProviderId } from './types';

/**
 * Portable representation of the local history index.
 *
 * The on-disk store is keyed by `tabId`, but a tab id only exists on the
 * machine that created it. A sync file therefore drops the tab id and keeps the
 * provider, the URL and the text; the importer maps the row to a local tab.
 */
export interface SyncEntry {
  providerId: ProviderId;
  service: string;
  url: string;
  title: string;
  text: string;
  capturedAt: number;
  titleOnly: boolean;
}

/**
 * A deletion that must survive a sync. The key is provider + canonical URL, so
 * a tombstone still matches a row whose local `tabId` changed.
 */
export interface SyncTombstone {
  key: string;
  deletedAt: number;
}

export interface HistorySyncFile {
  format: 'allai-history';
  version: 1;
  deviceId: string;
  deviceName: string;
  appVersion: string;
  exportedAt: number;
  entries: SyncEntry[];
  tombstones: SyncTombstone[];
  /**
   * When the index was last cleared. Entries captured before this timestamp are
   * ignored on every device, so "Clear index" is not undone by a sync.
   */
  clearedAt: number;
}

export interface SyncMergeResult {
  /** Rows that were new to this device. */
  imported: number;
  /** Rows that existed but received newer or richer text. */
  upgraded: number;
  /** Rows skipped because a newer tombstone exists. */
  tombstoned: number;
  /** Rows skipped because no local tab matches their service. */
  noTab: number;
  /** Rows whose data was already identical. */
  unchanged: number;
}

/** State of the cloud-folder sync, shown in Settings. */
export interface SyncStatus {
  enabled: boolean;
  folder: string;
  deviceId: string;
  deviceName: string;
  lastSyncAt?: number;
  lastError?: string;
  /** Number of sync files in the folder, including this device's own. */
  files: number;
  /**
   * Other devices' files that could not be read on this pass: still uploading,
   * not downloaded from the cloud yet, or damaged. They are retried on the next
   * pass; the status line must not claim "up to date" while any remain.
   */
  unread: number;
  /** File names behind `unread`, for the settings line. */
  unreadFiles: string[];
  /** Result of the last merge (imports + upgrades + skips). */
  lastMerge?: SyncMergeResult;
  /** Human summary of the last merge, for the settings line. */
  summary?: string;
}

/** A cloud-synced folder found on this machine. */
export interface DetectedSyncFolder {
  path: string;
  label: string;
}

export const SYNC_FILE_PREFIX = 'allai-history-';
export const SYNC_FILE_SUFFIX = '.json';
export const SYNC_FORMAT = 'allai-history';
export const SYNC_FORMAT_VERSION = 1;

const KNOWN_PROVIDERS = new Set<string>([
  'chatgpt', 'claude', 'gemini', 'copilot', 'perplexity', 'deepseek', 'grok',
  'huggingchat', 'kimi', 'glm', 'mistral', 'you', 'phind', 'poe', 'custom'
]);

function isProviderId(value: unknown): value is ProviderId {
  return typeof value === 'string' && KNOWN_PROVIDERS.has(value);
}

/** Stable cross-device identity of one conversation. */
export function syncKey(providerId: string, url: string): string {
  return `${providerId}:${canonicalHistoryUrl(url)}`;
}

export function toSyncEntry(entry: HistoryEntry): SyncEntry {
  return {
    providerId: entry.providerId,
    service: entry.service,
    url: entry.url,
    title: entry.title,
    text: entry.text,
    capturedAt: entry.capturedAt,
    titleOnly: entry.titleOnly
  };
}

export function syncFileName(deviceId: string): string {
  // Device ids are generated locally, but keep the name filesystem-safe.
  const safe = deviceId.replace(/[^a-z0-9_-]/gi, '');
  return `${SYNC_FILE_PREFIX}${safe || 'device'}${SYNC_FILE_SUFFIX}`;
}

export function isSyncFileName(name: string): boolean {
  return name.startsWith(SYNC_FILE_PREFIX) && name.endsWith(SYNC_FILE_SUFFIX);
}

function sanitizeEntry(raw: unknown): SyncEntry | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const value = raw as Record<string, unknown>;
  if (!isProviderId(value.providerId)) return undefined;
  if (typeof value.url !== 'string' || !/^https?:\/\//i.test(value.url)) return undefined;

  const title = normalizeText(typeof value.title === 'string' ? value.title : '');
  const text = typeof value.text === 'string' ? value.text : '';
  const capturedAt = typeof value.capturedAt === 'number' && Number.isFinite(value.capturedAt)
    ? value.capturedAt
    : Date.now();

  return {
    providerId: value.providerId,
    service: normalizeText(typeof value.service === 'string' ? value.service : '') || 'Service',
    url: value.url,
    title: title || 'Untitled chat',
    text,
    capturedAt,
    titleOnly: typeof value.titleOnly === 'boolean' ? value.titleOnly : text.trim().length === 0
  };
}

function sanitizeTombstone(raw: unknown): SyncTombstone | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const value = raw as Record<string, unknown>;
  if (typeof value.key !== 'string' || value.key.length < 3) return undefined;
  if (typeof value.deletedAt !== 'number' || !Number.isFinite(value.deletedAt)) return undefined;
  return { key: value.key, deletedAt: value.deletedAt };
}

/**
 * Parses a sync file defensively: a damaged or hand-edited file must never take
 * the app down. Unknown formats are rejected, individual bad rows are dropped.
 */
export function parseSyncFile(raw: string | Buffer): HistorySyncFile | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(typeof raw === 'string' ? raw : raw.toString('utf-8'));
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== 'object') return undefined;
  const value = parsed as Record<string, unknown>;
  if (value.format !== SYNC_FORMAT) return undefined;
  if (value.version !== SYNC_FORMAT_VERSION) return undefined;

  const entries = Array.isArray(value.entries)
    ? value.entries.map(sanitizeEntry).filter((entry): entry is SyncEntry => Boolean(entry))
    : [];
  const tombstones = Array.isArray(value.tombstones)
    ? value.tombstones.map(sanitizeTombstone).filter((item): item is SyncTombstone => Boolean(item))
    : [];

  return {
    format: SYNC_FORMAT,
    version: SYNC_FORMAT_VERSION,
    deviceId: typeof value.deviceId === 'string' && value.deviceId ? value.deviceId : 'unknown',
    deviceName: typeof value.deviceName === 'string' && value.deviceName ? value.deviceName : 'Unknown device',
    appVersion: typeof value.appVersion === 'string' ? value.appVersion : '',
    exportedAt: typeof value.exportedAt === 'number' ? value.exportedAt : Date.now(),
    entries,
    tombstones,
    clearedAt: typeof value.clearedAt === 'number' && Number.isFinite(value.clearedAt)
      ? value.clearedAt
      : 0
  };
}

/** A human label for the sync status line ("1,204 chats from 2 devices"). */
export function describeSyncMerge(result: SyncMergeResult, unread = 0): string {
  const parts: string[] = [];
  if (result.imported > 0) parts.push(`${result.imported} new`);
  if (result.upgraded > 0) parts.push(`${result.upgraded} updated`);
  if (result.tombstoned > 0) parts.push(`${result.tombstoned} deleted elsewhere`);
  if (unread > 0) parts.push(`${unread} file${unread === 1 ? '' : 's'} not read yet`);
  if (result.noTab > 0) parts.push(`${result.noTab} without a matching tab`);
  if (parts.length === 0) return 'Already up to date';
  return parts.join(', ');
}
