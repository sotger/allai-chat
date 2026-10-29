import fs from 'node:fs';
import path from 'node:path';

import { HistoryIndex } from '@shared/history-index';
import {
  chatKey,
  cleanHistoryTitle,
  historyStats,
  mergeHistoryEntry,
  normalizeText,
  type HistoryEntry,
  type HistoryHit,
  type HistoryStats
} from '@shared/history';

const COMPACT_RATIO = 1.5;
const FLUSH_DELAY_MS = 250;

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
  private readonly index = new HistoryIndex();
  private queue: string[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | undefined;
  private loaded = false;
  private loading: Promise<void> | undefined;

  constructor(userDataPath: string) {
    this.directory = path.join(userDataPath, 'history');
    this.filePath = path.join(this.directory, 'entries.jsonl');
  }

  get isLoaded(): boolean {
    return this.loaded;
  }

  load(): Promise<void> {
    if (this.loaded) return Promise.resolve();
    if (this.loading) return this.loading;

    this.loading = (async () => {
      let raw = '';
      try {
        raw = await fs.promises.readFile(this.filePath, 'utf-8');
      } catch {
        this.loaded = true;
        return;
      }

      const byId = new Map<string, HistoryEntry>();
      let lines = 0;
      for (const line of raw.split('\n')) {
        if (!line.trim()) continue;
        lines += 1;
        try {
          const parsed = JSON.parse(line) as HistoryEntry & { deleted?: boolean };
          if (parsed?.deleted === true && parsed.id) {
            byId.delete(parsed.id);
            continue;
          }
          if (!parsed?.id || !parsed.url) continue;
          byId.set(parsed.id, mergeHistoryEntry(byId.get(parsed.id), {
            ...parsed,
            text: normalizeText(parsed.text),
            title: cleanHistoryTitle(parsed.title, parsed.service || 'Untitled chat'),
            titleOnly: parsed.titleOnly ?? !normalizeText(parsed.text)
          }));
        } catch { /* skip a corrupted line, keep the rest */ }
      }

      // Drop queued rows for chats that are already indexed under another URL
      // variant (a project chat has a short and a slugged address). Without
      // this, the queue keeps re-reading conversations it already has.
      const pruned = this.pruneQueuedDuplicates(byId);
      for (const entry of byId.values()) this.index.add(entry);
      this.loaded = true;

      // Rewrite when the log has accumulated many updates for the same chats.
      if (pruned > 0 || (lines > 1000 && lines > byId.size * COMPACT_RATIO)) {
        await this.compact([...byId.values()]);
      }
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
    if (!this.index.get(id)) return;
    this.index.remove(id);
    this.queue.push(JSON.stringify({ id, deleted: true, deletedAt: Date.now() }));
    this.scheduleFlush();
  }

  /** Closing a service tab also drops the conversations captured for it. */
  async removeTab(tabId: string): Promise<void> {
    const doomed = this.index.all().filter((entry) => entry.tabId === tabId);
    if (doomed.length === 0) return;
    this.flushSync();
    for (const entry of doomed) this.index.remove(entry.id);
    await this.compact(this.index.all());
  }

  async clear(): Promise<void> {
    this.index.all().forEach((entry) => this.index.remove(entry.id));
    this.queue = [];
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }
    try {
      await fs.promises.rm(this.filePath, { force: true });
    } catch { /* non-fatal */ }
  }
}
