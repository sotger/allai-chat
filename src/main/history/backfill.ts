import { BrowserWindow, type Session, type WebContents } from 'electron';

import {
  canonicalHistoryUrl,
  chatKey,
  cleanHistoryTitle,
  historyId,
  isAuthUrl,
  looksLikeChatUrl,
  mergeIndexQueue,
  normalizeText,
  type HistoryProgress,
  type HistoryReport,
  type HistoryRunFailure,
  type HistorySummary
} from '@shared/history';
import type { ServiceTab } from '@shared/types';

import { captureScript, findListUrl, harvestTitles } from './capture';
import type { HistoryStore } from './store';

// Env overrides exist for local testing and screenshots only; the defaults are
// what ships. A manual run still respects the same human pacing either way.
const DEFAULT_PASS = 60;
/** A manual run is meant to reach an empty queue; this is only a runaway guard. */
const FULL_PER_SERVICE = 2000;
const LOAD_TIMEOUT_MS = 25_000;
const MAX_CONSECUTIVE_FAILURES = 3;
const BLOCK_PATTERN = /captcha|unusual traffic|verify (that )?you are (a )?human|are you a robot|подтвердите,? что вы не робот|доступ ограничен/i;

interface BackfillOptions {
  store: HistoryStore;
  getTab: (tabId: string) => ServiceTab | undefined;
  getTabs: () => ServiceTab[];
  getActiveTab: () => ServiceTab | undefined;
  getContents: (tab: ServiceTab) => WebContents | undefined;
  resolveSession: (tab: ServiceTab) => Session;
  prepareContents: (contents: WebContents) => void;
  guestPreloadPath: string;
  onProgress: (progress: HistoryProgress) => void;
  onReport: (report: HistoryReport) => void;
  isEnabled: () => boolean;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export interface BackfillRunOptions {
  reason?: 'manual' | 'auto';
  /** Cap for this run; the periodic reconciler uses a small batch. */
  limit?: number;
  /** Manual runs go until the queue is empty (with a runaway guard). */
  full?: boolean;
}

function resolveLimit(options: BackfillRunOptions): number {
  if (options.limit !== undefined) return Math.max(1, options.limit);
  const raw = process.env.ALLAI_INDEX_MAX;
  if (raw !== undefined && raw !== '') {
    const override = Number(raw);
    if (Number.isFinite(override)) return Math.max(1, override);
  }
  return options.full ? FULL_PER_SERVICE : DEFAULT_PASS;
}

function humanDelay(): Promise<void> {
  // 3.5–8 s between conversations, with an occasional longer pause. Sequential,
  // never parallel: a burst of requests is what makes a service suspicious.
  const override = process.env.ALLAI_INDEX_DELAY_MS;
  if (override !== undefined && override !== '' && Number.isFinite(Number(override))) {
    return sleep(Math.max(0, Number(override)));
  }
  return sleep(3500 + Math.random() * 4500);
}

/**
 * Fills the history index from a hidden window using the tab's own session.
 *
 * The window is positioned off-screen and made transparent instead of using
 * `show: false`: a hidden window reports `document.visibilityState = "hidden"`,
 * which is a strong bot signal on several services. It never takes focus and is
 * destroyed when the run stops. Requests are strictly sequential.
 */
export class HistoryBackfill {
  private window: BrowserWindow | undefined;
  private running = false;
  private stopRequested = false;
  private progress: HistoryProgress = { running: false, done: 0, total: 0 };
  private scopeTabIds: string[] = [];
  private reason: 'manual' | 'auto' = 'manual';
  private queueInitial = 0;
  private runSaved = 0;
  private runFailed = 0;
  private startedAt = 0;

  constructor(private readonly options: BackfillOptions) {}

  getProgress(): HistoryProgress {
    return this.progress;
  }

  isRunning(): boolean {
    return this.running;
  }

  stop(): void {
    this.stopRequested = true;
  }

  /** One service, used by the periodic reconciler and internal calls. */
  async start(tabId?: string, runOptions: BackfillRunOptions = {}): Promise<HistoryProgress> {
    if (this.running) return this.progress;

    const tab = tabId ? this.options.getTab(tabId) : this.options.getActiveTab();
    if (!tab) return this.finish({ error: 'No service tab to index.' });

    await this.options.store.load();
    if (!this.options.getContents(tab)) return this.finish({ error: 'That service is not loaded in a tab.' });

    const reason = runOptions.reason ?? 'manual';
    const limit = resolveLimit(runOptions);
    const startedAt = Date.now();

    this.running = true;
    this.stopRequested = false;
    this.prepareRun([tab], reason);
    this.emit({ running: true, service: tab.label, currentTitle: undefined, done: 0, total: 0 });
    try {
      const summary = await this.runTab(tab, { limit });
      this.emitReport({
        tabId: tab.id,
        service: tab.label,
        total: summary.total,
        saved: summary.saved,
        failures: summary.failures,
        startedAt,
        reason,
        services: [summary],
        stopped: this.stopRequested,
        remaining: this.options.store.unindexed(tab.id).length
      });
      return this.finish({
        service: tab.label,
        done: summary.saved + summary.failures.length,
        total: summary.total
      });
    } finally {
      this.running = false;
    }
  }

  /**
   * Manual run: every loaded service, one after another, starting with the
   * active tab. Each service keeps its own hidden window and its own pacing;
   * between services the app waits a little longer so the next site does not
   * see a sudden burst of requests.
   */
  async startAll(runOptions: BackfillRunOptions = {}): Promise<HistoryProgress> {
    if (this.running) return this.progress;
    await this.options.store.load();

    const activeId = this.options.getActiveTab()?.id;
    const tabs = this.options.getTabs()
      .filter((tab) => Boolean(this.options.getContents(tab)))
      .sort((a, b) => (a.id === activeId ? -1 : b.id === activeId ? 1 : 0));
    if (tabs.length === 0) return this.finish({ error: 'No loaded services to index.' });

    const reason = runOptions.reason ?? 'manual';
    const limit = resolveLimit(runOptions);
    const startedAt = Date.now();
    const summaries: HistorySummary[] = [];

    this.running = true;
    this.stopRequested = false;
    this.prepareRun(tabs, reason);
    this.emit({ running: true, service: undefined, currentTitle: undefined, done: 0, total: 0 });
    try {
      for (let index = 0; index < tabs.length; index += 1) {
        if (this.stopRequested || !this.options.isEnabled()) break;
        const tab = tabs[index];
        this.emit({
          running: true,
          service: tab.label,
          currentTitle: undefined,
          done: 0,
          total: 0,
          batchIndex: index + 1,
          batchTotal: tabs.length
        });
        summaries.push(await this.runTab(tab, { limit }));
        if (this.stopRequested) break;
        await this.pauseBetweenServices();
      }
    } finally {
      this.running = false;
    }

    const total = summaries.reduce((sum, item) => sum + item.total, 0);
    const saved = summaries.reduce((sum, item) => sum + item.saved, 0);
    const failures = summaries.flatMap((item) => item.failures);
    const remaining = tabs.reduce((sum, tab) => sum + this.options.store.unindexed(tab.id).length, 0);
    const label = tabs.length === 1 ? tabs[0].label : `${tabs.length} services`;
    this.emitReport({
      tabId: activeId ?? tabs[0].id,
      service: label,
      total,
      saved,
      failures,
      startedAt,
      reason,
      services: summaries,
      stopped: this.stopRequested,
      remaining
    });
    return this.finish({ service: label, done: saved + failures.length, total });
  }

  private async pauseBetweenServices(): Promise<void> {
    const override = process.env.ALLAI_INDEX_DELAY_MS;
    if (override !== undefined && override !== '' && Number.isFinite(Number(override))) {
      await sleep(Math.max(0, Number(override)));
      return;
    }
    await sleep(15_000 + Math.random() * 15_000);
  }

  private prepareRun(tabs: ServiceTab[], reason: 'manual' | 'auto'): void {
    // Clear the previous run's counters and batch position: `emit` merges into
    // the last progress object, so a single-service run would otherwise keep
    // showing the old `3/7` and a stale `finishedAt`.
    this.progress = { running: false, done: 0, total: 0 };
    this.scopeTabIds = tabs.map((tab) => tab.id);
    this.reason = reason;
    this.runSaved = 0;
    this.runFailed = 0;
    this.startedAt = Date.now();
    this.queueInitial = this.remainingInScope();
  }

  /** Conversations without text in every service touched by the current run. */
  private remainingInScope(): number {
    return this.scopeTabIds
      .reduce((sum, tabId) => sum + this.options.store.unindexed(tabId).length, 0);
  }

  /** Reads one service; the caller owns the `running` flag and the report. */
  private async runTab(tab: ServiceTab, runOptions: { limit: number }): Promise<HistorySummary> {
    const failuresList: HistoryRunFailure[] = [];
    let saved = 0;
    let done = 0;
    let total = 0;

    const live = this.options.getContents(tab);
    if (!live) {
      return { tabId: tab.id, service: tab.label, total: 0, saved: 0, failures: failuresList };
    }

    // Titles from the visible tab first: everything in the chat list becomes
    // searchable even if the body pass is interrupted.
    const visible = await harvestTitles(live, { deep: false });
    this.storeTitles(tab, visible);

    try {
      this.window = this.createWindow(this.options.resolveSession(tab));
      const contents = this.window.webContents;
      let httpStatus = 0;
      contents.on('did-navigate', (_event, _url, code) => { httpStatus = code; });

      this.emit({ running: true, service: tab.label, done: 0, total: 0, error: undefined });

      // Deep harvest happens in the hidden window, never in the visible tab:
      // scrolling the user's sidebar would be disruptive.
      const loaded = await this.load(contents, tab.url);
      if (loaded) await this.waitForStableText(contents);
      // A chat page only shows recent sidebar links; the full history usually
      // sits behind "View all" (Perplexity's /library). Load that page in the
      // same hidden window before harvesting.
      if (loaded) {
        const listUrl = await findListUrl(contents);
        if (listUrl && canonicalHistoryUrl(listUrl) !== canonicalHistoryUrl(contents.getURL())) {
          const listLoaded = await this.load(contents, listUrl);
          if (listLoaded) await this.waitForStableText(contents);
        }
      }
      const deep = loaded ? await harvestTitles(contents, { deep: true }) : [];
      this.storeTitles(tab, deep.length > 0 ? deep : visible);

      // The visible/deep sidebar is not enough: older chats and ChatGPT
      // project conversations disappear from it, so the queue stored on disk is
      // merged in. Without this, "Index now" reports nothing to do while the
      // index still has hundreds of conversations without text.
      const indexed = this.options.store.indexedChatKeys(tab.id);
      const fresh = (deep.length > 0 ? deep : visible)
        .filter((link) => looksLikeChatUrl(link.url))
        .filter((link) => {
          const key = chatKey(link.url);
          if (key && indexed.has(key)) return false;
          const existing = this.options.store.get(historyId(tab.id, link.url));
          return !existing || existing.titleOnly;
        });
      const queued = this.options.store.unindexed(tab.id)
        .filter((entry) => {
          const key = chatKey(entry.url);
          return !key || !indexed.has(key);
        })
        .map((entry) => ({ url: entry.url, title: entry.title }));
      const candidates = mergeIndexQueue(fresh, queued, runOptions.limit);

      total = candidates.length;
      if (candidates.length === 0) return { tabId: tab.id, service: tab.label, total: 0, saved: 0, failures: failuresList };

      let consecutiveFailures = 0;
      for (const link of candidates) {
        if (this.stopRequested || !this.options.isEnabled()) break;

        this.emit({ running: true, service: tab.label, currentTitle: link.title, done, total });
        httpStatus = 0;

        const ok = await this.load(contents, link.url);
        if (!ok || httpStatus === 429 || httpStatus === 403 || isAuthUrl(contents.getURL())) {
          consecutiveFailures += 1;
          done += 1;
          this.runFailed += 1;
          const reasonText = httpStatus === 429 || httpStatus === 403
            ? 'the service rate limited the request'
            : !ok ? 'the page did not load in time' : 'the service asked to sign in again';
          failuresList.push({ title: link.title, url: link.url, reason: reasonText });
          if (httpStatus === 429 || httpStatus === 403) {
            this.emit({
              running: true,
              service: tab.label,
              done,
              total,
              error: 'The service is rate limiting requests. Moving to the next service.'
            });
            break;
          }
          if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) break;
          await humanDelay();
          continue;
        }

        await this.waitForStableText(contents);
        const page = await contents.executeJavaScript(captureScript).catch(() => undefined) as
          | { url?: string; title?: string; text?: string }
          | undefined;

        if (!page?.url || isAuthUrl(page.url)) {
          consecutiveFailures += 1;
          done += 1;
          this.runFailed += 1;
          failuresList.push({ title: link.title, url: link.url, reason: 'the service asked to sign in again' });
          await humanDelay();
          continue;
        }

        // The chat may have been deleted or moved to another id.
        if (chatKey(page.url) && chatKey(link.url) && chatKey(page.url) !== chatKey(link.url)) {
          consecutiveFailures += 1;
          done += 1;
          this.runFailed += 1;
          failuresList.push({ title: link.title, url: link.url, reason: 'the conversation no longer exists at that address' });
          await humanDelay();
          continue;
        }

        const text = normalizeText(page.text);
        if (BLOCK_PATTERN.test(text.slice(0, 4000))) {
          this.runFailed += 1;
          this.emit({
            running: true,
            service: tab.label,
            done,
            total,
            error: 'The service asked for human verification. Moving to the next service.'
          });
          break;
        }

        if (text.length >= 40) {
          consecutiveFailures = 0;
          saved += 1;
          this.runSaved += 1;
          const savedId = historyId(tab.id, page.url);
          this.options.store.upsert({
            id: savedId,
            tabId: tab.id,
            providerId: tab.providerId,
            service: tab.label,
            url: page.url,
            title: cleanHistoryTitle(page.title, link.title || tab.label),
            text,
            capturedAt: Date.now(),
            titleOnly: false
          });
          // A redirect may give the conversation a different canonical URL.
          // Drop the queued title-only row so it does not stay in the queue.
          const linkId = historyId(tab.id, link.url);
          if (linkId !== savedId) this.options.store.removeById(linkId);
        } else {
          consecutiveFailures += 1;
          this.runFailed += 1;
          failuresList.push({ title: link.title, url: link.url, reason: 'no readable conversation text was rendered' });
        }

        done += 1;
        this.emit({ running: true, service: tab.label, currentTitle: link.title, done, total });

        if (done % 12 === 0 && process.env.ALLAI_INDEX_DELAY_MS === undefined) {
          await sleep(15_000 + Math.random() * 20_000);
        } else {
          await humanDelay();
        }
      }
    } finally {
      this.destroyWindow();
    }

    return { tabId: tab.id, service: tab.label, total, saved, failures: failuresList };
  }

  private emitReport(report: Omit<HistoryReport, 'finishedAt'>): void {
    this.options.onReport({ ...report, finishedAt: Date.now() });
  }

  private storeTitles(tab: ServiceTab, links: Array<{ url: string; title: string }>): void {
    const indexed = this.options.store.indexedChatKeys(tab.id);
    for (const link of links) {
      if (!looksLikeChatUrl(link.url)) continue;
      const key = chatKey(link.url);
      if (key && indexed.has(key)) continue;
      const id = historyId(tab.id, link.url);
      if (this.options.store.get(id)) continue;
      this.options.store.upsert({
        id,
        tabId: tab.id,
        providerId: tab.providerId,
        service: tab.label,
        url: link.url,
        title: cleanHistoryTitle(link.title, tab.label),
        text: '',
        capturedAt: Date.now(),
        titleOnly: true
      });
    }
  }

  private createWindow(ses: Session): BrowserWindow {
    const window = new BrowserWindow({
      width: 1280,
      height: 900,
      x: -20_000,
      y: -20_000,
      show: false,
      frame: false,
      skipTaskbar: true,
      focusable: false,
      opacity: 0,
      backgroundColor: '#000000',
      webPreferences: {
        session: ses,
        preload: this.options.guestPreloadPath,
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        backgroundThrottling: false
      }
    });
    window.webContents.setAudioMuted(true);
    window.setIgnoreMouseEvents(true);
    // This window is internal: it reads pages, it must never open anything.
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', (event, url) => {
      if (!/^https?:\/\//i.test(url)) event.preventDefault();
    });
    this.options.prepareContents(window.webContents);
    // Off-screen and transparent, but technically "visible" so the page does
    // not think it is running headless.
    window.showInactive();
    return window;
  }

  private destroyWindow(): void {
    if (!this.window || this.window.isDestroyed()) {
      this.window = undefined;
      return;
    }
    this.window.removeAllListeners();
    this.window.destroy();
    this.window = undefined;
  }

  private async load(contents: WebContents, url: string): Promise<boolean> {
    try {
      await Promise.race([
        contents.loadURL(url),
        sleep(LOAD_TIMEOUT_MS).then(() => {
          if (!contents.isDestroyed()) contents.stop();
          throw new Error('timeout');
        })
      ]);
      return true;
    } catch {
      return false;
    }
  }
  /**
   * The services are SPAs: `did-stop-loading` fires long before the answer is
   * in the DOM, and sometimes never fires at all. Wait until the rendered text
   * stops growing instead.
   */
  private async waitForStableText(contents: WebContents): Promise<void> {
    const started = Date.now();
    let previous = -1;
    let stableSince = 0;
    while (Date.now() - started < 12_000) {
      if (contents.isDestroyed()) return;
      const length = await contents.executeJavaScript('(document.body ? document.body.innerText.length : 0)')
        .catch(() => 0) as number;
      if (length > 200 && length === previous) {
        if (!stableSince) stableSince = Date.now();
        if (Date.now() - stableSince > 700) return;
      } else {
        stableSince = 0;
      }
      previous = length;
      await sleep(250);
    }
  }

  private emit(patch: Partial<HistoryProgress>): void {
    this.progress = {
      ...this.progress,
      ...patch,
      mode: this.reason,
      queueInitial: this.queueInitial,
      queueRemaining: this.remainingInScope(),
      runSaved: this.runSaved,
      runFailed: this.runFailed,
      startedAt: this.startedAt
    };
    this.options.onProgress(this.progress);
  }

  private finish(patch: Partial<HistoryProgress>): HistoryProgress {
    this.emit({ ...patch, running: false, currentTitle: undefined, finishedAt: Date.now() });
    return this.progress;
  }
}
