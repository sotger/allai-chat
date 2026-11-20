import fs from 'node:fs';
import path from 'node:path';

import { HistoryIndex } from '@shared/history-index';
import {
  chatKey,
  cleanHistoryTitle,
  historyStats,
  isAccessWallText,
  isUtilityUrl,
  mergeHistoryEntry,
  normalizeText,
  type HistoryEntry,
  type HistoryHit,
  type HistoryStats
} from '@shared/history';
import { syncKey, type SyncTombstone } from '@shared/sync';

const COMPACT_RATIO = 1.5;
const FLUSH_DELAY_MS = 250;
const TOMBSTONE_FLUSH_DELAY_MS = 400;

interface StoredTombstone extends SyncTombstone {
  /**
   * `false` for deletions that should stay on this machine (closing a service
   * tab). They still block a re-import here, but are not written to the sync
   * file, so another device's copy is not wiped.
   */
  propagate: boolean;
}

/**
 * Append-only JSONL store plus an in-memory index.
 *
 * Why not SQLite: a native module would need `electron-rebuild` for every
 * platform in CI. At chat-history scale (tens of thousands of rows, a few
 * hundred MB of text) a JSONL file and a rebuilt in-memory index are fast
 * enough and keep the packaged app dependency-free.
 */
export class HistoryStore {
  private readonly directory: string;
  private readonly filePath: string;
  private readonly tombstonePath: string;
  private readonly index = new HistoryIndex();
  private queue: string[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | undefined;
  private tombstoneTimer: ReturnType<typeof setTimeout> | undefined;
  private tombstones = new Map<string, StoredTombstone>();
  private clearedAt = 0;
  private tombstonesDirty = false;
  private loaded = false;
  private loading: Promise<void> | undefined;
  private changeListener: (() => void) | undefined;

  constructor(userDataPath: string) {
    this.directory = path.join(userDataPath, 'history');
    this.filePath = path.join(this.directory, 'entries.jsonl');
    this.tombstonePath = path.join(this.directory, 'tombstones.json');
  }

  /**
   * Called after a row is added, upgraded or forgotten. The main process
   * throttles it into the `historyUpdated` IPC event for the queue panel.
   */
  setOnChange(listener: (() => void) | undefined): void {
    this.changeListener = listener;
  }

  private changed(): void {
    this.changeListener?.();
  }

  get isLoaded(): boolean {
    return this.loaded;
  }

  load(): Promise<void> {
    if (this.loaded) return Promise.resolve();
    if (this.loading) return this.loading;

    this.loading = (async () => {
      await this.loadTombstones();
      let raw = '';
      try {
        raw = await fs.promises.readFile(this.filePath, 'utf-8');
      } catch {
        this.loaded = true;
        return;
      }

      const byId = new Map<string, HistoryEntry>();
      let lines = 0;
      let dropped = 0;
      for (const line of raw.split('\n')) {
        if (!line.trim()) continue;
        lines += 1;
        try {
          const parsed = JSON.parse(line) as HistoryEntry & { deleted?: boolean; deletedAt?: number };
          if (parsed?.deleted === true && parsed.id) {
            const doomed = byId.get(parsed.id);
            if (doomed) this.rememberTombstone(doomed, parsed.deletedAt ?? Date.now(), false);
            byId.delete(parsed.id);
            continue;
          }
          if (!parsed?.id || !parsed.url) continue;
          // Older builds captured "/chats", "/library", "/subscribe" and
          // private-link walls as conversations. Drop them on load.
          if (isUtilityUrl(parsed.url) || isAccessWallText(parsed.text)) {
            dropped += 1;
            continue;
          }
          byId.set(parsed.id, mergeHistoryEntry(byId.get(parsed.id), {
            ...parsed,
            text: normalizeText(parsed.text),
            title: cleanHistoryTitle(parsed.title, parsed.service || 'Untitled chat'),
            titleOnly: parsed.titleOnly ?? !normalizeText(parsed.text)
          }));
        } catch { /* skip a corrupted line, keep the rest */ }
      }

      // A tombstone can be newer than the row it deleted (a sync from another
      // device wrote the deletion while this file still had the old capture).
      for (const [id, entry] of byId) {
        if (this.isTombstoned(entry.providerId, entry.url, entry.capturedAt)) byId.delete(id);
      }

      // Drop queued rows for chats that are already indexed under another URL
      // variant (a project chat has a short and a slugged address). Without
      // this, the queue keeps re-reading conversations it already has.
      const pruned = this.pruneQueuedDuplicates(byId);
      for (const entry of byId.values()) this.index.add(entry);
      this.loaded = true;

      // Rewrite when the log has accumulated many updates for the same chats.
      if (pruned > 0 || dropped > 0 || (lines > 1000 && lines > byId.size * COMPACT_RATIO)) {
        await this.compact([...byId.values()]);
      }
      this.flushTombstonesSync();
    })();

    return this.loading;
  }

  private async compact(entries: HistoryEntry[]): Promise<void> {
    try {
      await fs.promises.mkdir(this.directory, { recursive: true });
      const temp = `${this.filePath}.tmp`;
      const body = entries.map((entry) => JSON.stringify(entry)).join('\n');
      await fs.promises.writeFile(temp, body ? `${body}\n` : '', 'utf-8');
      await fs.promises.rename(temp, this.filePath);
    } catch { /* non-fatal */ }
  }

  private async loadTombstones(): Promise<void> {
    try {
      const raw = await fs.promises.readFile(this.tombstonePath, 'utf-8');
      const parsed = JSON.parse(raw) as {
        version?: number;
        clearedAt?: number;
        tombstones?: StoredTombstone[];
      };
      if (typeof parsed.clearedAt === 'number' && Number.isFinite(parsed.clearedAt)) {
        this.clearedAt = parsed.clearedAt;
      }
      if (!Array.isArray(parsed.tombstones)) return;
      for (const item of parsed.tombstones) {
        if (!item || typeof item.key !== 'string' || !item.key) continue;
        if (typeof item.deletedAt !== 'number' || !Number.isFinite(item.deletedAt)) continue;
        this.tombstones.set(item.key, {
          key: item.key,
          deletedAt: item.deletedAt,
          propagate: item.propagate === true
        });
      }
    } catch { /* first launch or a damaged file */ }
  }

  private recordTombstone(key: string, deletedAt: number, propagate: boolean): void {
    const existing = this.tombstones.get(key);
    const next: StoredTombstone = {
      key,
      deletedAt: Math.max(existing?.deletedAt ?? 0, deletedAt),
      propagate: (existing?.propagate ?? false) || propagate
    };
    if (existing && existing.deletedAt === next.deletedAt && existing.propagate === next.propagate) return;
    this.tombstones.set(key, next);
    this.tombstonesDirty = true;
    if (this.loaded) this.scheduleTombstoneFlush();
  }

  /** Records a deletion so a sync file from another device cannot undo it. */
  private rememberTombstone(entry: HistoryEntry, deletedAt: number, propagate: boolean): void {
    this.recordTombstone(syncKey(entry.providerId, entry.url), Math.max(deletedAt, entry.capturedAt), propagate);
  }

  /** True when this conversation was deleted on this device after `capturedAt`. */
  isTombstoned(providerId: string, url: string, capturedAt: number): boolean {
    if (this.clearedAt > 0 && this.clearedAt >= capturedAt) return true;
    const item = this.tombstones.get(syncKey(providerId, url));
    return Boolean(item && item.deletedAt >= capturedAt);
  }

  /** Timestamp of the last "Clear index", for sync files. */
  getClearedAt(): number {
    return this.clearedAt;
  }

  /**
   * Applies a "Clear index" that happened on another device: everything
   * captured before that moment is gone, newer local captures survive.
   */
  async applyRemoteClear(clearedAt: number): Promise<number> {
    if (!Number.isFinite(clearedAt) || clearedAt <= this.clearedAt) return 0;
    this.clearedAt = clearedAt;
    this.tombstonesDirty = true;

    let removed = 0;
    for (const entry of this.index.all()) {
      if (entry.capturedAt > clearedAt) continue;
      this.index.remove(entry.id);
      removed += 1;
    }

    if (removed > 0) {
      this.flushSync();
      await this.compact(this.index.all());
      this.changed();
    } else {
      this.flushTombstonesSync();
    }
    return removed;
  }

  /** Deletions that are safe to write into a shared sync file. */
  tombstonesForSync(): SyncTombstone[] {
    return [...this.tombstones.values()]
      .filter((item) => item.propagate)
      .map(({ key, deletedAt }) => ({ key, deletedAt }));
  }

  /**
   * Applies deletions that arrived from another device. A row that was
   * captured after the deletion (re-opened locally) is kept.
   */
  async applyRemoteTombstones(items: readonly SyncTombstone[]): Promise<number> {
    const byKey = new Map<string, HistoryEntry[]>();
    for (const entry of this.index.all()) {
      const key = syncKey(entry.providerId, entry.url);
      const list = byKey.get(key);
      if (list) list.push(entry);
      else byKey.set(key, [entry]);
    }

    let removed = 0;
    for (const item of items) {
      if (!item?.key || typeof item.deletedAt !== 'number') continue;
      this.recordTombstone(item.key, item.deletedAt, true);
      const local = this.tombstones.get(item.key);
      if (!local || local.deletedAt < item.deletedAt) continue;
      for (const entry of byKey.get(item.key) ?? []) {
        if (entry.capturedAt > item.deletedAt) continue;
        if (!this.index.get(entry.id)) continue;
        this.index.remove(entry.id);
        removed += 1;
      }
    }

    if (removed > 0) {
      this.flushSync();
      await this.compact(this.index.all());
      this.changed();
    }
    return removed;
  }

  private scheduleTombstoneFlush(): void {
    if (this.tombstoneTimer) return;
    this.tombstoneTimer = setTimeout(() => {
      this.tombstoneTimer = undefined;
      this.flushTombstonesSync();
    }, TOMBSTONE_FLUSH_DELAY_MS);
  }

  private flushTombstonesSync(): void {
    if (!this.tombstonesDirty) return;
    try {
      fs.mkdirSync(this.directory, { recursive: true });
      const body = JSON.stringify({
        version: 1,
        clearedAt: this.clearedAt,
        tombstones: [...this.tombstones.values()]
      });
      fs.writeFileSync(this.tombstonePath, body, 'utf-8');
      this.tombstonesDirty = false;
    } catch { /* non-fatal */ }
  }

  /**
   * Removes queue rows that point at a conversation already stored with text,
   * and collapses several title-only rows for the same chat. Returns how many
   * rows were dropped so `load()` can rewrite the file once.
   */
  private pruneQueuedDuplicates(byId: Map<string, HistoryEntry>): number {
    const groups = new Map<string, HistoryEntry[]>();
    for (const entry of byId.values()) {
      const key = chatKey(entry.url);
      if (!key) continue;
      const groupKey = `${entry.tabId}:${key}`;
      const list = groups.get(groupKey);
      if (list) list.push(entry);
      else groups.set(groupKey, [entry]);
    }

    let removed = 0;
    for (const list of groups.values()) {
      if (list.length < 2) continue;
      const indexed = list.filter((entry) => !entry.titleOnly);
      if (indexed.length > 0) {
        for (const entry of list) {
          if (!entry.titleOnly) continue;
          byId.delete(entry.id);
          removed += 1;
        }
        continue;
      }
      // Only queued variants: keep the one with the most useful title.
      list.sort((a, b) => b.title.length - a.title.length || b.capturedAt - a.capturedAt);
      for (const entry of list.slice(1)) {
        byId.delete(entry.id);
        removed += 1;
      }
    }
    return removed;
  }

  /** Conversation ids (per tab) that already have body text. */
  indexedChatKeys(tabId?: string): Set<string> {
    const keys = new Set<string>();
    for (const entry of this.index.all()) {
      if (entry.titleOnly) continue;
      if (tabId && entry.tabId !== tabId) continue;
      const key = chatKey(entry.url);
      if (key) keys.add(key);
    }
    return keys;
  }

  upsert(next: HistoryEntry): HistoryEntry {
    const previous = this.index.get(next.id);
    // Re-visiting a page must not append an identical row: a chat is captured
    // after every navigation, and the log would otherwise grow forever.
    if (previous
      && previous.text === next.text
      && previous.title === next.title
      && previous.titleOnly === next.titleOnly) {
      return previous;
    }
    const merged = mergeHistoryEntry(previous, next);
    this.index.add(merged);
    this.queue.push(JSON.stringify(merged));
    this.scheduleFlush();
    this.changed();
    return merged;
  }

  private scheduleFlush(): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined;
      void this.flush();
    }, FLUSH_DELAY_MS);
  }

  private async flush(): Promise<void> {
    if (this.queue.length === 0) return;
    const lines = this.queue.join('\n');
    this.queue = [];
    try {
      await fs.promises.mkdir(this.directory, { recursive: true });
      await fs.promises.appendFile(this.filePath, `${lines}\n`, 'utf-8');
    } catch { /* non-fatal: the in-memory index still works */ }
  }

  /** Called on quit; the debounce timer would otherwise drop the last writes. */
  flushSync(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }
    if (this.tombstoneTimer) {
      clearTimeout(this.tombstoneTimer);
      this.tombstoneTimer = undefined;
    }
    this.flushTombstonesSync();
    if (this.queue.length === 0) return;
    const lines = this.queue.join('\n');
    this.queue = [];
    try {
      fs.mkdirSync(this.directory, { recursive: true });
      fs.appendFileSync(this.filePath, `${lines}\n`, 'utf-8');
    } catch { /* non-fatal */ }
  }

  get(id: string): HistoryEntry | undefined {
    return this.index.get(id);
  }

  all(): HistoryEntry[] {
    return this.index.all();
  }

  /**
   * Conversations that are known from a chat list but still have no body text.
   * This is the queue a backfill run consumes, independent of whether the chat
   * is still visible in the service's sidebar.
   */
  unindexed(tabId?: string): HistoryEntry[] {
    return this.index.all()
      .filter((entry) => entry.titleOnly && (!tabId || entry.tabId === tabId));
  }

  search(query: string, limit = 30): HistoryHit[] {
    return this.index.search(query, limit);
  }

  stats(): HistoryStats {
    return historyStats(this.index.all());
  }

  /**
   * Forgets one row. A tombstone is appended instead of rewriting the whole
   * file, so a stale title-only entry (a redirect, a deleted chat, a link that
   * never renders text) does not reappear on the next launch.
   */
  removeById(id: string): void {
    const existing = this.index.get(id);
    if (!existing) return;
    this.index.remove(id);
    this.rememberTombstone(existing, Date.now(), true);
    this.queue.push(JSON.stringify({ id, deleted: true, deletedAt: Date.now() }));
    this.scheduleFlush();
    this.changed();
  }

  /** Closing a service tab also drops the conversations captured for it. */
  async removeTab(tabId: string): Promise<void> {
    const doomed = this.index.all().filter((entry) => entry.tabId === tabId);
    if (doomed.length === 0) return;
    this.flushSync();
    // The deletion stays local: the same conversation may belong to a different
    // tab on another device, and closing a tab here must not wipe that copy.
    for (const entry of doomed) this.rememberTombstone(entry, Date.now(), false);
    for (const entry of doomed) this.index.remove(entry.id);
    await this.compact(this.index.all());
    this.flushSync();
    this.changed();
  }

  async clear(): Promise<void> {
    this.clearedAt = Date.now();
    this.tombstonesDirty = true;
    const doomed = this.index.all();
    for (const entry of doomed) this.rememberTombstone(entry, this.clearedAt, true);
    doomed.forEach((entry) => this.index.remove(entry.id));
    this.queue = [];
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }
    try {
      await fs.promises.rm(this.filePath, { force: true });
    } catch { /* non-fatal */ }
    // Write tombstones before the caller syncs, so a cloud copy cannot restore
    // what was just cleared.
    this.flushSync();
    this.changed();
  }
}
