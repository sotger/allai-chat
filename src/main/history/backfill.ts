import { BrowserWindow, type Session, type WebContents } from 'electron';

import {
  historyId,
  isAuthUrl,
  looksLikeChatUrl,
  normalizeText,
  type HistoryProgress,
  type HistoryReport,
  type HistoryRunFailure,
  type HistorySummary
} from '@shared/history';
import type { ServiceTab } from '@shared/types';

import { captureScript, harvestTitles } from './capture';
import type { HistoryStore } from './store';

// Env overrides exist for local testing and screenshots only; the defaults are
// what ships. A manual run still respects the same human pacing either way.
function envNumber(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw >= 0 ? raw : fallback;
}

const MAX_PER_RUN = Math.max(1, envNumber('ALLAI_INDEX_MAX', 60));
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

function chatKey(url: string): string | undefined {
  return /[0-9a-f]{8,}/i.exec(url)?.[0]?.toLowerCase();
}

export interface BackfillRunOptions {
  reason?: 'manual' | 'auto';
  /** Cap for this run; the periodic reconciler uses a small batch. */
  limit?: number;
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
    const limit = Math.max(1, runOptions.limit ?? MAX_PER_RUN);
    const startedAt = Date.now();

    this.running = true;
    this.stopRequested = false;
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
        services: [summary]
      });
      return this.finish({ service: tab.label, done: summary.total, total: summary.total });
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
    const limit = Math.max(1, runOptions.limit ?? MAX_PER_RUN);
    const startedAt = Date.now();
    const summaries: HistorySummary[] = [];

    this.running = true;
    this.stopRequested = false;
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
    const label = tabs.length === 1 ? tabs[0].label : `${tabs.length} services`;
    this.emitReport({
      tabId: activeId ?? tabs[0].id,
      service: label,
      total,
      saved,
      failures,
      startedAt,
      reason,
      services: summaries
    });
    return this.finish({ service: label, done: total, total });
  }

  private async pauseBetweenServices(): Promise<void> {
    const override = process.env.ALLAI_INDEX_DELAY_MS;
    if (override !== undefined && override !== '' && Number.isFinite(Number(override))) {
      await sleep(Math.max(0, Number(override)));
      return;
    }
    await sleep(15_000 + Math.random() * 15_000);
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
      const deep = loaded ? await harvestTitles(contents, { deep: true }) : [];
      this.storeTitles(tab, deep.length > 0 ? deep : visible);

      const candidates = (deep.length > 0 ? deep : visible)
        .filter((link) => looksLikeChatUrl(link.url))
        .filter((link) => {
          const existing = this.options.store.get(historyId(tab.id, link.url));
          return !existing || existing.titleOnly;
        })
        .slice(0, runOptions.limit);

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
          failuresList.push({ title: link.title, url: link.url, reason: 'the service asked to sign in again' });
          await humanDelay();
          continue;
        }

        // The chat may have been deleted or moved to another id.
        if (chatKey(page.url) && chatKey(link.url) && chatKey(page.url) !== chatKey(link.url)) {
          consecutiveFailures += 1;
          done += 1;
          failuresList.push({ title: link.title, url: link.url, reason: 'the conversation no longer exists at that address' });
          await humanDelay();
          continue;
        }

        const text = normalizeText(page.text);
        if (BLOCK_PATTERN.test(text.slice(0, 4000))) {
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
          this.options.store.upsert({
            id: historyId(tab.id, page.url),
            tabId: tab.id,
            providerId: tab.providerId,
            service: tab.label,
            url: page.url,
            title: normalizeText(page.title) || link.title,
            text,
            capturedAt: Date.now(),
            titleOnly: false
          });
        } else {
          consecutiveFailures += 1;
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
    for (const link of links) {
      if (!looksLikeChatUrl(link.url)) continue;
      const id = historyId(tab.id, link.url);
      if (this.options.store.get(id)) continue;
      this.options.store.upsert({
        id,
        tabId: tab.id,
        providerId: tab.providerId,
        service: tab.label,
        url: link.url,
        title: normalizeText(link.title) || tab.label,
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
    this.progress = { ...this.progress, ...patch };
    this.options.onProgress(this.progress);
  }

  private finish(patch: Partial<HistoryProgress>): HistoryProgress {
    this.emit({ ...patch, running: false, currentTitle: undefined, finishedAt: Date.now() });
    return this.progress;
  }
}
