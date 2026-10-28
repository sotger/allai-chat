import fs from 'node:fs';
import path from 'node:path';
import type { WebContents } from 'electron';

import { historyId, looksLikeChatUrl } from '@shared/history';
import type { ServiceTab } from '@shared/types';

import { harvestTitles } from './capture';
import type { HistoryBackfill } from './backfill';
import type { HistoryStore } from './store';

const CHECK_INTERVAL_MS = 30 * 60 * 1000;
/** Do not re-check the same service more often than this. */
const MIN_AGE_MS = 6 * 60 * 60 * 1000;
/** New services get a first pass quickly, then the normal schedule. */
const NEW_TAB_DELAY_MS = 2 * 60 * 1000;
/** The automatic pass is deliberately small: it tops up the index, it does not rebuild it. */
const AUTO_LIMIT = 15;

interface ReconcilerOptions {
  store: HistoryStore;
  backfill: HistoryBackfill;
  getTabs: () => ServiceTab[];
  getContents: (tab: ServiceTab) => WebContents | undefined;
  isEnabled: () => boolean;
  statePath: string;
}

/**
 * Keeps the local index in step with the services without a full re-crawl:
 * every few hours it reads the chat list of one service and queues only the
 * conversations that have no stored text yet. New or re-added services are
 * picked up automatically, and the pass is small and paced like a manual run.
 */
export class HistoryReconciler {
  private timer: ReturnType<typeof setInterval> | undefined;
  private firstCheck: ReturnType<typeof setTimeout> | undefined;
  private tabTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private lastCheck = new Map<string, number>();
  private checking = false;

  constructor(private readonly options: ReconcilerOptions) {}

  start(): void {
    this.load();
    this.stopTimers();
    this.firstCheck = setTimeout(() => void this.check(), 3 * 60 * 1000);
    this.timer = setInterval(() => void this.check(), CHECK_INTERVAL_MS);
  }

  stop(): void {
    this.stopTimers();
  }

  private stopTimers(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.firstCheck) clearTimeout(this.firstCheck);
    for (const timer of this.tabTimers.values()) clearTimeout(timer);
    this.timer = undefined;
    this.firstCheck = undefined;
    this.tabTimers.clear();
  }

  /** A new (or re-added) service: check it once its first page has loaded. */
  noteTabAdded(tabId: string): void {
    if (!this.options.isEnabled()) return;
    const existing = this.tabTimers.get(tabId);
    if (existing) clearTimeout(existing);
    this.tabTimers.set(tabId, setTimeout(() => {
      this.tabTimers.delete(tabId);
      void this.check(tabId, true);
    }, NEW_TAB_DELAY_MS));
  }

  noteTabRemoved(tabId: string): void {
    const timer = this.tabTimers.get(tabId);
    if (timer) clearTimeout(timer);
    this.tabTimers.delete(tabId);
    if (this.lastCheck.delete(tabId)) this.save();
  }

  async check(onlyTabId?: string, force = false): Promise<void> {
    if (this.checking || this.options.backfill.isRunning()) return;
    if (!this.options.isEnabled()) return;

    const tabs = this.options.getTabs().filter((tab) => !onlyTabId || tab.id === onlyTabId);
    if (tabs.length === 0) return;

    // One service per cycle: the run itself takes minutes and must not compete
    // with a manual pass or with the user's own browsing.
    const candidates = tabs
      .filter((tab) => force || Date.now() - (this.lastCheck.get(tab.id) ?? 0) > MIN_AGE_MS)
      .filter((tab) => Boolean(this.options.getContents(tab)))
      .sort((a, b) => (this.lastCheck.get(a.id) ?? 0) - (this.lastCheck.get(b.id) ?? 0));
    const tab = candidates[0];
    if (!tab) return;

    this.checking = true;
    try {
      const contents = this.options.getContents(tab);
      if (!contents) return;
      const links = await harvestTitles(contents, { deep: false });
      const missing = links.filter((link) => {
        if (!looksLikeChatUrl(link.url)) return false;
        const entry = this.options.store.get(historyId(tab.id, link.url));
        return !entry || entry.titleOnly;
      });

      this.lastCheck.set(tab.id, Date.now());
      this.save();

      if (missing.length === 0) return;
      await this.options.backfill.start(tab.id, {
        reason: 'auto',
        limit: Math.min(AUTO_LIMIT, missing.length)
      });
    } catch { /* a failed check is retried on the next tick */ } finally {
      this.checking = false;
    }
  }

  private load(): void {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.options.statePath, 'utf-8')) as Record<string, number>;
      for (const [tabId, at] of Object.entries(parsed)) {
        if (typeof at === 'number') this.lastCheck.set(tabId, at);
      }
    } catch { /* first run */ }
  }

  private save(): void {
    try {
      fs.mkdirSync(path.dirname(this.options.statePath), { recursive: true });
      fs.writeFileSync(this.options.statePath, JSON.stringify(Object.fromEntries(this.lastCheck), null, 2), 'utf-8');
    } catch { /* non-fatal */ }
  }
}
