import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Menu,
  MenuItem,
  type MenuItemConstructorOptions,
  nativeTheme,
  session,
  shell,
  type WebContents
} from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { execFile } from 'node:child_process';
import { v4 as uuid } from 'uuid';

import { IPC_CHANNELS, type AddTabInput, type BrowserSignInOptions, type CookieFilePick, type DownloadRecord, type GoogleVaultState, type MenuAction, type PermissionStatus, type SafariCookieAccess } from '@shared/ipc';
import { COOKIE_TEXT_MAX_BYTES } from '@shared/cookies';
import { isDownloadableMediaUrl } from '@shared/media';
import { getProviderConfig } from '@shared/providers';
import { createServiceTab } from '@shared/tabs';
import type { AppState, Preferences, ServiceTab } from '@shared/types';
import { DownloadManager } from './downloads';
import { importCookiesIntoTab, tabHost } from './cookie-import';
import { importSafariCookies, importSafariGoogleSession, importSafariSessionNow, readSafariGoogleSession, readSafariGoogleState, watchSafariSession } from './browser-sign-in';
import { LoginFlowController } from './login-flow';
import { cookiesSatisfiedBy, serviceEntryUrl } from '@shared/login-policy';
import { readSafariCookies, safariCookieFolderReadable } from './safari-cookies';
import { clickSafariSignIn, closeSafariTab, probeSafariControl, type SafariControlStatus } from './safari-control';
import { GOOGLE_SIGNIN_PARTITION, copyGoogleCookies, fingerprintGoogleSession, hasGoogleSession, isSignedInToGoogle, readGoogleCookies } from './google-auth';
import { isGoogleAuthCookieName } from '@shared/google-auth';
import { getPreferences, isDarkTheme, loadPreferences, savePreferences } from './preferences';
import { contentsForTab, findInTab, openSearchResult, searchTabs, stopAllFind } from './search';
import { broadcastPrompt } from './broadcast';
import { checkForUpdates, initAutoUpdater, RELEASES_URL } from './updater';
import { HistoryBackfill } from './history/backfill';
import { capturePage, harvestTitles, titleEntry, toHistoryEntry } from './history/capture';
import { HistoryReconciler } from './history/reconcile';
import { isChatGptUrl, searchChatGpt } from './history/server-search';
import { HistoryStore } from './history/store';
import { HistorySync, detectSyncFolders } from './sync';
import {
  chatKey,
  historyId,
  looksLikeChatUrl,
  type HistoryQueueSnapshot
} from '@shared/history';
import { describeSyncMerge } from '@shared/sync';

// ── Chrome fingerprint (Google blocks embedded browsers without this) ──
const chromeVersion = process.versions.chrome || '138.0.0.0';
const chromeMajor = chromeVersion.split('.')[0] || chromeVersion;
const chromeUserAgent = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVersion} Safari/537.36`;

// Keep in sync with src/preload/webview.ts.
const chromeBrands = [
  '"Not)A;Brand";v="8"',
  `"Chromium";v="${chromeMajor}"`,
  `"Google Chrome";v="${chromeMajor}"`
].join(', ');
const chromeFullVersionList = [
  '"Not)A;Brand";v="8.0.0.0"',
  `"Chromium";v="${chromeVersion}"`,
  `"Google Chrome";v="${chromeVersion}"`
].join(', ');

// The webview preload must live outside app.asar: Electron loads guest preloads
// through Node's require, which cannot read asar archives.
function resolveGuestPreloadPath(): string {
  const unpacked = path.join(process.resourcesPath, 'app.asar.unpacked', 'out', 'preload', 'webview.cjs');
  if (app.isPackaged && fs.existsSync(unpacked)) return unpacked;
  return path.join(__dirname, '../preload/webview.cjs');
}

const guestPreloadPath = resolveGuestPreloadPath();

// Allows tests and screenshots to run with an isolated profile.
if (process.env.ALLAI_USER_DATA_DIR) {
  app.setPath('userData', path.resolve(process.env.ALLAI_USER_DATA_DIR));
}

app.setName('ALLAI-CHAT');
app.userAgentFallback = chromeUserAgent;

const ISSUES_URL = 'https://github.com/sotger/allai-chat/issues';

let mainWindow: BrowserWindow | undefined;
let googleSignInWindow: BrowserWindow | undefined;

const downloadManager = new DownloadManager(
  () => getPreferences().downloadDirectory,
  (downloads) => broadcastDownloads(downloads)
);

// ── Local history index ──────────────────────────────────────────────
// Conversations visited in any tab are captured on navigation and indexed
// locally, so global search also finds chats that are not open right now.
const historyStore = new HistoryStore(app.getPath('userData'));

// The queue panel listens to one throttled signal instead of every capture.
let historyUpdatedTimer: ReturnType<typeof setTimeout> | undefined;
historyStore.setOnChange(() => {
  historySync?.schedule();
  if (historyUpdatedTimer) return;
  historyUpdatedTimer = setTimeout(() => {
    historyUpdatedTimer = undefined;
    sendToRenderer(IPC_CHANNELS.historyUpdated, { at: Date.now() });
  }, 400);
});

let historySync: HistorySync | undefined;

const historyBackfill = new HistoryBackfill({
  store: historyStore,
  getTab: (tabId) => state.tabs.find(tab => tab.id === tabId),
  getTabs: () => state.tabs,
  getActiveTab: () => state.tabs.find(tab => tab.id === state.activeTabId),
  getContents: (tab) => contentsForTab(tab),
  resolveSession: (tab) => session.fromPartition(tab.partition),
  prepareContents: (contents) => contents.setUserAgent(chromeUserAgent),
  guestPreloadPath,
  isEnabled: () => getPreferences().historyIndexEnabled,
  onProgress: (progress) => sendToRenderer(IPC_CHANNELS.historyProgress, progress),
  onReport: (report) => sendToRenderer(IPC_CHANNELS.historyReport, report)
});

// Tops up the index in the background: new services, new chats, and services
// that were removed and added back later.
const historyReconciler = new HistoryReconciler({
  store: historyStore,
  backfill: historyBackfill,
  getTabs: () => state.tabs,
  getContents: (tab) => contentsForTab(tab),
  isEnabled: () => {
    const preferences = getPreferences();
    return preferences.historyIndexEnabled && preferences.historyBackfillEnabled;
  },
  statePath: path.join(app.getPath('userData'), 'history', 'reconcile.json')
});

const captureTimers = new Map<string, ReturnType<typeof setTimeout>>();
const lastHarvestAt = new Map<string, number>();

function scheduleCapture(contents: WebContents): void {
  if (contents.isDestroyed() || !getPreferences().historyIndexEnabled) return;
  const tab = tabForContents(contents);
  if (!tab) return;
  const existing = captureTimers.get(tab.id);
  if (existing) clearTimeout(existing);
  captureTimers.set(tab.id, setTimeout(() => {
    captureTimers.delete(tab.id);
    void (async () => {
      const page = await capturePage(contents);
      if (!page) return;
      const entry = toHistoryEntry(tab, page);
      if (entry) historyStore.upsert(entry);
    })();
  }, 2000));
}

/**
 * Copies the titles from the service's own chat list. This works for every
 * service without per-site selectors and makes the whole history searchable
 * before any body text is captured.
 */
async function harvestTab(contents: WebContents, force = false): Promise<number> {
  if (contents.isDestroyed() || !getPreferences().historyIndexEnabled) return 0;
  const tab = tabForContents(contents);
  if (!tab) return 0;

  const last = lastHarvestAt.get(tab.id) ?? 0;
  if (!force && Date.now() - last < 5 * 60 * 1000) return 0;
  lastHarvestAt.set(tab.id, Date.now());

  const links = await harvestTitles(contents);
  const indexed = historyStore.indexedChatKeys(tab.id);
  let added = 0;
  for (const link of links) {
    if (!looksLikeChatUrl(link.url)) continue;
    const key = chatKey(link.url);
    if (key && indexed.has(key)) continue;
    const id = historyId(tab.id, link.url);
    if (historyStore.get(id)) continue;
    const entry = titleEntry(tab, link.url, link.title);
    if (!entry) continue;
    historyStore.upsert(entry);
    added += 1;
  }
  return added;
}

// ── Window bounds persistence ────────────────────────────────────────
interface WindowBounds { x: number; y: number; width: number; height: number; isMaximized: boolean }

function getWindowBoundsPath(): string {
  return path.join(app.getPath('userData'), 'window-bounds.json');
}

function loadWindowBounds(): Partial<WindowBounds> {
  try {
    return JSON.parse(fs.readFileSync(getWindowBoundsPath(), 'utf-8'));
  } catch {
    return {};
  }
}

function saveWindowBounds(win: BrowserWindow): void {
  try {
    const isMaximized = win.isMaximized();
    const bounds = isMaximized ? loadWindowBounds() : win.getBounds();
    fs.writeFileSync(getWindowBoundsPath(), JSON.stringify({ ...bounds, isMaximized }), 'utf-8');
  } catch { /* non-fatal */ }
}

// ── Tab state ────────────────────────────────────────────────────────
const state: AppState = { tabs: [], activeTabId: null };

// Cloud-folder sync: one portable JSON file per device in a folder the user
// already syncs. No API, no OAuth; the cloud client moves the file.
historySync = new HistorySync({
  store: historyStore,
  getTabs: () => state.tabs,
  getFolder: () => getPreferences().syncFolder,
  isEnabled: () => getPreferences().syncEnabled,
  onStatus: (status) => sendToRenderer(IPC_CHANNELS.syncStatus, status),
  onIndexChanged: () => sendToRenderer(IPC_CHANNELS.historyUpdated, { at: Date.now() })
});

/** How many queue rows per service are sent to the panel in one snapshot. */
const QUEUE_ITEMS_PER_GROUP = 500;

/**
 * Groups the conversations that still have no text by service, in tab order.
 * The panel only needs titles and links; the runner reads the same rows from
 * the store, so this snapshot is a view, not a second queue.
 */
function buildQueueSnapshot(): HistoryQueueSnapshot {
  const groups = state.tabs
    .map((tab) => {
      const indexed = historyStore.indexedChatKeys(tab.id);
      const entries = historyStore.unindexed(tab.id)
        .filter((entry) => {
          const key = chatKey(entry.url);
          return !key || !indexed.has(key);
        })
        .sort((a, b) => a.title.localeCompare(b.title));

      const items = entries.slice(0, QUEUE_ITEMS_PER_GROUP).map((entry) => ({
        id: entry.id,
        tabId: entry.tabId,
        service: entry.service,
        url: entry.url,
        title: entry.title,
        capturedAt: entry.capturedAt
      }));

      return {
        tabId: tab.id,
        service: tab.label,
        providerId: tab.providerId,
        color: tab.color,
        icon: tab.icon,
        queued: entries.length,
        items,
        truncated: entries.length > items.length
      };
    })
    .filter((group) => group.queued > 0);

  const stats = historyStore.stats();
  return {
    groups,
    queued: groups.reduce((sum, group) => sum + group.queued, 0),
    entries: stats.entries,
    withText: stats.withText
  };
}

// The app was briefly called "allai-chat" during development; keep that data
// when the userData folder is renamed to match the product name.
function migrateLegacyData(): void {
  try {
    const appData = app.getPath('appData');
    const legacy = path.join(appData, 'allai-chat');
    const current = path.join(appData, 'ALLAI-CHAT');
    // On case-insensitive filesystems both paths point at the same folder.
    if (!fs.existsSync(legacy) || fs.existsSync(current)) return;
    fs.renameSync(legacy, current);
  } catch { /* non-fatal */ }
}

function getStatePath(): string {
  return path.join(app.getPath('userData'), 'tabs.json');
}

function loadState(): void {
  try {    const parsed = JSON.parse(fs.readFileSync(getStatePath(), 'utf-8')) as Partial<AppState>;
    if (Array.isArray(parsed.tabs)) {
      state.tabs = parsed.tabs
        .filter((tab): tab is ServiceTab =>
          Boolean(tab && tab.id && tab.providerId && tab.url && tab.partition)
        )
        // Le Chat was renamed Mistral Vibe; keep existing tabs in sync.
        .map((tab) => (tab.providerId === 'mistral' && (tab.label === 'Le Chat' || tab.label === 'Mistral')
          ? { ...tab, label: 'Mistral Vibe' }
          : tab));
    }
    const active = parsed.activeTabId;
    state.activeTabId = state.tabs.some(tab => tab.id === active)
      ? active ?? null
      : state.tabs[0]?.id ?? null;
  } catch {
    state.tabs = [];
    state.activeTabId = null;
  }
}

function saveState(): void {
  try {
    fs.writeFileSync(getStatePath(), JSON.stringify(state, null, 2), 'utf-8');
  } catch { /* non-fatal */ }
}

function broadcastState(): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(IPC_CHANNELS.stateChanged, state);
  }
  rebuildMenu();
}

// ── Sessions ─────────────────────────────────────────────────────────
const configuredPartitions = new Set<string>();

function configureSession(ses: Electron.Session): void {
  ses.setUserAgent(chromeUserAgent);
  downloadManager.attach(ses);

  // Chrome client hints — Google's sign-in checks these.
  ses.webRequest.onBeforeSendHeaders((details, callback) => {
    const headers = { ...details.requestHeaders };
    headers['Sec-CH-UA'] = chromeBrands;
    headers['Sec-CH-UA-Mobile'] = '?0';
    headers['Sec-CH-UA-Platform'] = '"Windows"';
    headers['Sec-CH-UA-Platform-Version'] = '"15.0.0"';
    headers['Sec-CH-UA-Full-Version-List'] = chromeFullVersionList;
    headers['Sec-CH-UA-Arch'] = '"x86"';
    headers['Sec-CH-UA-Bitness'] = '"64"';
    callback({ requestHeaders: headers });
  });

  ses.setPermissionRequestHandler((contents, permission, callback, details) => {
    // Camera/microphone are sensitive: ask the user every time. Everything else
    // in the allow-list is standard browser functionality. Geolocation and idle
    // detection are intentionally never granted.
    if (permission === 'media') {
      const host = (() => {
        try {
          return new URL(details.requestingUrl || contents.getURL()).hostname;
        } catch {
          return 'This page';
        }
      })();
      const mediaTypes = (details as Electron.MediaAccessPermissionRequest).mediaTypes;
      const mediaLabel = mediaTypes?.length ? mediaTypes.join(' and ') : 'camera/microphone';
      const choice = dialog.showMessageBoxSync({
        type: 'question',
        buttons: ['Deny', 'Allow'],
        defaultId: 1,
        cancelId: 0,
        title: 'Permission request',
        message: `${host} wants to use your ${mediaLabel}.`,
        detail: 'Only allow this if you trust the service.'
      });
      callback(choice === 1);
      return;
    }

    const allowed = [
      'clipboard-sanitized-write',
      'mediaKeySystem', 'notifications', 'fullscreen', 'pointerLock',
      'storage-access'
    ];
    callback(allowed.includes(permission));
  });
}

function configurePartition(partition: string): void {
  if (configuredPartitions.has(partition)) return;
  configureSession(session.fromPartition(partition));
  configuredPartitions.add(partition);
}

// ── Tabs ─────────────────────────────────────────────────────────────
async function addTab(input: AddTabInput): Promise<ServiceTab> {
  const provider = getProviderConfig(input.providerId);
  const existingCount = state.tabs.filter(tab => tab.providerId === input.providerId).length;
  const tab = createServiceTab({
    id: uuid(),
    providerId: provider.id,
    customUrl: input.customUrl,
    label: input.label,
    existingCount
  });

  configurePartition(tab.partition);

  // Reuse the Google session before the webview mounts, so the first
  // "Continue with Google" already shows the account chooser.
  if (getPreferences().reuseGoogleSignIn && !tab.isolatedAuth) {
    await copyGoogleCookies(session.fromPartition(GOOGLE_SIGNIN_PARTITION), session.fromPartition(tab.partition));
  }

  state.tabs.push(tab);
  state.activeTabId = tab.id;
  saveState();
  broadcastState();
  historyReconciler.noteTabAdded(tab.id);
  return tab;
}

function removeTab(tabId: string): void {
  const tab = state.tabs.find(item => item.id === tabId);
  if (!tab) return;

  const index = state.tabs.indexOf(tab);
  state.tabs = state.tabs.filter(item => item.id !== tabId);
  if (state.activeTabId === tabId) {
    const next = state.tabs[index] ?? state.tabs[index - 1] ?? null;
    state.activeTabId = next?.id ?? null;
  }
  saveState();
  broadcastState();

  // Conversations captured for this tab belong to the profile that is being
  // wiped below; keeping them would produce search hits that cannot open.
  historyReconciler.noteTabRemoved(tabId);
  void historyStore.removeTab(tabId);

  // The tab owned its own isolated profile — wipe it so credentials don't
  // linger on disk once the tab is gone.
  const ses = session.fromPartition(tab.partition);
  configuredPartitions.delete(tab.partition);
  void ses.clearStorageData().catch(() => undefined);
  void ses.clearCache().catch(() => undefined);
}

/**
 * Tabs are stored with the URL of the conversation that was open, so the same
 * chat is restored on the next launch (and global search can actually see it).
 * This is updated on every main-frame navigation, including SPA route changes.
 */
function tabForContents(contents: WebContents): ServiceTab | undefined {
  const contentsSession = contents.session;
  return state.tabs.find(tab => session.fromPartition(tab.partition) === contentsSession);
}

let saveUrlTimer: ReturnType<typeof setTimeout> | undefined;

function rememberTabUrl(contents: WebContents, url: string): void {
  if (contents.isDestroyed() || contents.getType() !== 'webview') return;
  if (!isHttpUrl(url)) return;
  // Never persist a detour through an OAuth provider.
  if (isAuthHost(hostOf(url))) return;
  const tab = tabForContents(contents);
  if (!tab || tab.url === url) return;
  tab.url = url;
  if (saveUrlTimer) clearTimeout(saveUrlTimer);
  saveUrlTimer = setTimeout(() => {
    saveState();
    broadcastState();
  }, 700);
}

function setActiveTab(tabId: string): void {
  if (!state.tabs.some(tab => tab.id === tabId)) return;
  state.activeTabId = tabId;
  saveState();
  broadcastState();
}

function closeActiveTab(): void {
  if (state.activeTabId) removeTab(state.activeTabId);
  else if (state.tabs.length > 0) removeTab(state.tabs[state.tabs.length - 1].id);
}

function cycleTab(direction: 1 | -1): void {
  if (state.tabs.length === 0) return;
  const current = state.tabs.findIndex(tab => tab.id === state.activeTabId);
  const next = current === -1
    ? (direction > 0 ? 0 : state.tabs.length - 1)
    : (current + direction + state.tabs.length) % state.tabs.length;
  setActiveTab(state.tabs[next].id);
}

// ── Per-tab actions (sidebar context menu) ───────────────────────────
function reloadTab(tabId: string): void {
  const tab = state.tabs.find(item => item.id === tabId);
  if (tab) contentsForTab(tab)?.reload();
}

/**
 * Reloads a tab that just received Google cookies. Only the render matters: a
 * page that already finished loading keeps showing its signed-out state until it
 * is reloaded, and a page that is still loading requests the cookies anyway.
 */
function reloadAfterGoogleCookies(tabId: string): void {
  const tab = state.tabs.find(item => item.id === tabId);
  if (!tab) return;
  const contents = contentsForTab(tab);
  if (!contents || contents.isDestroyed() || contents.isLoading()) return;
  reloadTab(tabId);
}

/** Active "sign in in Safari" watchers, one per tab. */
const browserSignInWatchers = new Map<string, () => void>();

/**
 * Stops the handoff for one tab, or all of them when no tab is named. Watchers
 * are per tab on purpose: starting a login in another service used to cancel the
 * one already waiting in the browser, and the finished login was then lost.
 */
function cancelBrowserSignIn(tabId?: string): void {
  if (tabId) {
    const stop = browserSignInWatchers.get(tabId);
    browserSignInWatchers.delete(tabId);
    stop?.();
    return;
  }
  for (const stop of browserSignInWatchers.values()) stop();
  browserSignInWatchers.clear();
}

/**
 * Diagnostics for the browser handoff: a small append-only log in userData.
 * Cookie values are never written, only hosts and counts.
 */
function logBrowserSignIn(message: string): void {
  const line = `[${new Date().toISOString()}] ${message}\n`;
  console.log(`[allai] browser sign-in: ${message}`);
  try {
    fs.appendFileSync(path.join(app.getPath('userData'), 'browser-sign-in.log'), line);
  } catch {
    /* logging must never break the flow */
  }
}

/** Per-tab cooldown so a page that retries a passkey request cannot open Safari twice. */
const browserSignInStartedAt = new Map<string, number>();
const BROWSER_SIGN_IN_COOLDOWN_MS = 30_000;

/** Bring the app forward after a browser handoff finished. */
function focusMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
  app.focus({ steal: true });
}

function navigateTab(tabId: string, url: string): void {
  const tab = state.tabs.find(item => item.id === tabId);
  if (!tab) return;
  tab.url = url;
  saveState();
  broadcastState();
  void contentsForTab(tab)?.loadURL(url).catch(() => undefined);
}

/**
 * URL and host a tab signs in at. `url` is where the tab goes afterwards (the
 * service itself); `openUrl` is what the browser opens, which is a deep sign-in
 * entry only when it stays on the same host — cookies are matched by host, and
 * the tab's own `state`/`nonce` must not be reused in the browser.
 */
function browserSignInTarget(
  tab: ServiceTab,
  fromPasskey = false,
  fromAuth = false
): { url: string; openUrl: string; host: string } {
  const provider = getProviderConfig(tab.providerId);
  const url = tab.providerId === 'custom' ? tab.url || provider.url : provider.url;
  const host = tabHost(url) || tabHost(tab.url);
  const deep = fromPasskey ? provider.passkeySignInUrl : fromAuth ? provider.signInUrl : undefined;
  const openUrl = deep && isHttpUrl(deep) && tabHost(deep) === host ? deep : url;
  return { url, openUrl, host };
}

/** The service's "signed in" cookie rule, when it declares one. */
function sessionPatternFor(tab: ServiceTab): string | undefined {
  return getProviderConfig(tab.providerId).sessionCookiePattern;
}

function openInSafari(url: string): void {
  if (!isHttpUrl(url)) return;
  // Default browser would be wrong here: the cookie store we read is Safari's.
  execFile('/usr/bin/open', ['-a', 'Safari', url], () => undefined);
}

/**
 * Opens the service's own sign-in page in Safari and imports the session the
 * browser creates. Used by the dialog button and by the passkey interceptor:
 * Electron cannot complete WebAuthn, so the login has to happen in a browser.
 */
type BrowserSignInOutcome = 'imported' | 'opened' | 'none';

async function beginBrowserSignIn(
  tab: ServiceTab,
  fromPasskey = false,
  options: { skipReuse?: boolean; fromAuth?: boolean } = {}
): Promise<BrowserSignInOutcome> {
  if (process.platform !== 'darwin') return 'none';
  const target = browserSignInTarget(tab, fromPasskey, options.fromAuth === true);
  if (!target.host) return 'none';

  const tabSession = session.fromPartition(tab.partition);

  // Safari may already be signed in (the user logged in on a previous attempt).
  // Take that session first — no need to open or repeat anything. Callers that
  // saw the service reject imported cookies pass `skipReuse`.
  const existing = options.skipReuse
    ? { imported: 0, hasSession: false as boolean, error: 'none' as const }
    : await importSafariSessionNow(tabSession, target.host, sessionPatternFor(tab));
  // Device ids and cache cookies are not a login: only a real session cookie
  // means Safari can answer instead of the user.
  if (existing.imported > 0 && existing.hasSession) {
    logBrowserSignIn(`reused Safari session tab=${tab.label} host=${target.host} imported=${existing.imported}`);
    loginFlow.onImported(tab.id, existing.imported);
    navigateTab(tab.id, serviceEntryUrl(target.url));
    // Safari is signed in to Google too: keep that session for the other tabs.
    void captureGoogleVault();
    sendToRenderer(IPC_CHANNELS.browserSignInResult, {
      tabId: tab.id,
      state: 'imported',
      imported: existing.imported,
      host: target.host
    });
    return 'imported';
  }
  logBrowserSignIn(
    `no reusable session tab=${tab.label} host=${target.host} `
    + `imported=${existing.imported} session=${existing.hasSession} error=${existing.error ?? '-'}`
  );

  const now = Date.now();
  const startedAt = browserSignInStartedAt.get(tab.id) ?? 0;
  if (now - startedAt < BROWSER_SIGN_IN_COOLDOWN_MS) {
    // Still counts as "opened" for the caller, but say so: a silent no-op here
    // used to look like the app had ignored the click.
    logBrowserSignIn(`browser cooldown tab=${tab.label} waited=${Math.round((now - startedAt) / 1000)}s`);
    return 'opened';
  }
  browserSignInStartedAt.set(tab.id, now);

  cancelBrowserSignIn(tab.id);
  openInSafari(target.openUrl);

  logBrowserSignIn(`open tab=${tab.label} host=${target.host} url=${target.openUrl}`);
  const stop = watchSafariSession({
    tabId: tab.id,
    host: target.host,
    sessionCookiePattern: sessionPatternFor(tab),
    session: tabSession,
    deadlineMs: 10 * 60_000,
    onEvent: logBrowserSignIn,
    onDone: (result) => {
      browserSignInWatchers.delete(tab.id);
      // The tab was left on the auth provider; go to the service itself, now
      // with the imported cookies in place, and pull the app forward so the
      // user does not have to switch back from the browser manually.
      if (result.state === 'imported') {
        loginFlow.onImported(tab.id, result.imported ?? 0);
        navigateTab(tab.id, serviceEntryUrl(target.url));
        // The browser did its job; put the user back in the app.
        void closeSafariTab(target.host);
        activateApp();
        // The login that just landed may also be a Google sign-in; store it for
        // the services that are added next.
        void captureGoogleVault();
      } else if (result.state === 'timeout' || result.state === 'denied') {
        // The session is not coming (no grant, or Safari never wrote it): do not
        // leave a dead provider page behind — give the service back.
        loginFlow.onWatchEnd(tab.id, result.state);
        const contents = contentsForTab(tab);
        if (contents && !contents.isDestroyed() && isAuthHost(hostOf(contents.getURL()))) {
          navigateTab(tab.id, serviceEntryUrl(target.url));
        }
      }
      sendToRenderer(IPC_CHANNELS.browserSignInResult, result);
    }
  });
  browserSignInWatchers.set(tab.id, stop);
  return 'opened';
}

/**
 * Copies the live Safari Google session into a tab, but only when the tab does
 * not already hold it. Reloading an OAuth page for nothing is what produced a
 * 400 on the second sign-in attempt.
 */
async function copyLiveGoogleInto(tab: ServiceTab): Promise<number> {
  const browser = readSafariGoogleState();
  if (browser.state !== 'signed-in' || browser.cookies.length === 0) return 0;

  const tabSession = session.fromPartition(tab.partition);
  const existing = await readGoogleCookies(tabSession);
  // Compare only the login cookies: preference/analytics cookies change all the
  // time and must not force a reload of the OAuth page.
  const liveAuth = browser.cookies.filter((cookie) => isGoogleAuthCookieName(cookie.name));
  const tabAuth = existing.filter((cookie) => isGoogleAuthCookieName(cookie.name)).map((cookie) => ({
    domain: cookie.domain ?? '', path: cookie.path ?? '/', name: cookie.name,
    value: cookie.value, expirationDate: cookie.expirationDate
  }));
  if (liveAuth.length > 0 && cookiesSatisfiedBy(liveAuth, tabAuth)) return 0;

  const copied = await importSafariCookies(tabSession, browser.cookies);
  if (copied > 0) logBrowserSignIn(`google live copy tab=${tab.label} cookies=${copied}`);
  return copied;
}

/** Same for the stored snapshot, used when Safari's store is not readable. */
async function copyVaultGoogleInto(tab: ServiceTab): Promise<number> {
  const vault = session.fromPartition(GOOGLE_SIGNIN_PARTITION);
  const cookies = await readGoogleCookies(vault);
  if (cookies.length === 0) return 0;

  const tabSession = session.fromPartition(tab.partition);
  const existing = await readGoogleCookies(tabSession);
  const vaultAuth = cookies.filter((cookie) => isGoogleAuthCookieName(cookie.name));
  const tabAuth = existing.filter((cookie) => isGoogleAuthCookieName(cookie.name)).map((cookie) => ({
    domain: cookie.domain ?? '', path: cookie.path ?? '/', name: cookie.name,
    value: cookie.value, expirationDate: cookie.expirationDate
  }));
  if (vaultAuth.length > 0 && cookiesSatisfiedBy(vaultAuth, tabAuth)) return 0;

  const copied = await copyGoogleCookies(vault, tabSession);
  if (copied > 0) logBrowserSignIn(`google vault copy tab=${tab.label} cookies=${copied}`);
  return copied;
}

/**
 * One state machine for every sign-in, whichever provider and whichever way it
 * started. The hooks are the only place that touches sessions, windows and
 * Safari; the transitions themselves live in `src/main/login-flow.ts`.
 */
const loginFlow = new LoginFlowController({
  now: () => Date.now(),
  newId: () => uuid().slice(0, 8),
  log: logBrowserSignIn,
  sharingEnabled: (tabId) => {
    const tab = state.tabs.find((item) => item.id === tabId);
    return Boolean(tab) && getPreferences().reuseGoogleSignIn && tab?.isolatedAuth !== true;
  },
  // No Safari off macOS: the vault fallback is the only shared session there.
  browserGoogle: () => (process.platform === 'darwin' ? readSafariGoogleState().state : 'unknown'),
  vaultHasGoogle: () => hasGoogleSession(session.fromPartition(GOOGLE_SIGNIN_PARTITION)),
  tabHasGoogle: async (tabId) => {
    const tab = state.tabs.find((item) => item.id === tabId);
    return tab ? hasGoogleSession(session.fromPartition(tab.partition)) : false;
  },
  copyBrowserGoogle: (tabId) => {
    const tab = state.tabs.find((item) => item.id === tabId);
    return tab ? copyLiveGoogleInto(tab) : Promise.resolve(0);
  },
  copyVaultGoogle: (tabId) => {
    const tab = state.tabs.find((item) => item.id === tabId);
    return tab ? copyVaultGoogleInto(tab) : Promise.resolve(0);
  },
  // The provider page has not committed yet when the auth navigation fires:
  // reloading now would reload the service page and cancel the sign-in.
  reloadProvider: (tabId) => {
    const tab = state.tabs.find((item) => item.id === tabId);
    const contents = tab ? contentsForTab(tab) : undefined;
    if (!contents || contents.isDestroyed()) return;
    const reloadIfOnProvider = (): void => {
      if (contents.isDestroyed()) return;
      if (!isAuthHost(hostOf(contents.getURL()))) return;
      contents.reload();
    };
    if (contents.isLoading()) contents.once('did-stop-loading', reloadIfOnProvider);
    else reloadIfOnProvider();
  },
  reloadTab: (tabId) => reloadTab(tabId),
  navigateTab: (tabId, url) => navigateTab(tabId, url),
  openBrowser: (tabId, trigger) => {
    const tab = state.tabs.find((item) => item.id === tabId);
    if (!tab) return;
    void beginBrowserSignIn(tab, trigger === 'passkey', { fromAuth: trigger === 'navigation' })
      .then((outcome) => {
        if (outcome === 'opened') scheduleAuthReturn(tab);
        // No Safari on this platform (or no host): let the next attempt decide anew.
        if (outcome === 'none') loginFlow.cancel(tabId);
      });
  },
  notify: (tabId, message) => notifySignInBlocked(tabId, undefined, message),
  entryUrl: (tabId) => {
    const tab = state.tabs.find((item) => item.id === tabId);
    return tab ? serviceEntryUrl(tab.url) : '';
  },
  isAuthUrl: (url) => isAuthHost(hostOf(url))
});

/** Tells the renderer that a handoff was deliberately not started, and why. */
function notifySignInBlocked(tabId: string, host: string | undefined, message: string): void {
  sendToRenderer(IPC_CHANNELS.browserSignInResult, {
    tabId,
    state: 'blocked',
    host,
    message
  });
}

/**
 * After Safari was opened for a sign-in, bring the tab back to the service
 * instead of leaving it on a dead provider page, and (when Automation allows it)
 * press the service's own “Sign in” button in Safari so the user does not have
 * to repeat the click.
 */
function scheduleAuthReturn(tab: ServiceTab): void {
  const provider = getProviderConfig(tab.providerId);
  const root = tab.providerId === 'custom' ? tab.url || provider.url : provider.url;

  setTimeout(() => {
    const contents = contentsForTab(tab);
    if (!contents || contents.isDestroyed()) return;
    if (!isAuthHost(hostOf(contents.getURL()))) return;
    navigateTab(tab.id, serviceEntryUrl(root));
  }, 1500);

  const host = tabHost(root);
  if (!host) return;
  setTimeout(() => {
    void clickSafariSignIn(host).then((result) => {
      logBrowserSignIn(`safari-control tab=${tab.label} host=${host} result=${result}`);
      if (result === 'ok' || result === 'denied' || result === 'no-js') {
        safariControlCache = result;
        sendToRenderer(IPC_CHANNELS.permissionStatus, permissionStatus());
      }
    });
  }, 3500);
}

function setTabAuthSharing(tabId: string, shared: boolean): void {
  const tab = state.tabs.find(item => item.id === tabId);
  if (!tab) return;

  tab.isolatedAuth = !shared;
  saveState();
  broadcastState();
  if (!shared || !getPreferences().reuseGoogleSignIn) return;

  void (async () => {
    const vault = session.fromPartition(GOOGLE_SIGNIN_PARTITION);
    const target = session.fromPartition(tab.partition);
    if (await hasGoogleSession(target)) return;
    if (await copyGoogleCookies(vault, target) > 0) {
      contentsForTab(tab)?.reload();
    }
  })();
}

async function resetTabSession(tabId: string): Promise<void> {
  const tab = state.tabs.find(item => item.id === tabId);
  if (!tab) return;

  if (mainWindow) {
    const choice = dialog.showMessageBoxSync(mainWindow, {
      type: 'warning',
      buttons: ['Cancel', 'Reset login'],
      defaultId: 1,
      cancelId: 0,
      message: `Reset login info for ${tab.label}?`,
      detail: 'Cookies, storage and cache for this service will be cleared. Other tabs keep their accounts. This tab will not receive the shared Google session.'
    });
    if (choice !== 1) return;
  }

  // Keep the tab independent: otherwise the shared Google vault could sign it
  // back in on the next launch, defeating "use a different account here".
  tab.isolatedAuth = true;
  saveState();
  broadcastState();

  const ses = session.fromPartition(tab.partition);
  await Promise.all([
    ses.clearStorageData().catch(() => undefined),
    ses.clearCache().catch(() => undefined),
    ses.clearAuthCache().catch(() => undefined)
  ]);
  contentsForTab(tab)?.reload();
}

function showTabContextMenu(tabId: string): void {
  const tab = state.tabs.find(item => item.id === tabId);
  if (!tab) return;

  const shared = !tab.isolatedAuth;
  const menu = Menu.buildFromTemplate([
    {
      label: 'Reload page',
      accelerator: 'CmdOrCtrl+R',
      click: () => {
        setActiveTab(tabId);
        reloadTab(tabId);
      }
    },
    {
      label: 'Find in page…',
      accelerator: 'CmdOrCtrl+F',
      click: () => {
        setActiveTab(tabId);
        sendMenuAction('find');
      }
    },
    {
      label: 'Find in all services…',
      accelerator: 'CmdOrCtrl+Shift+F',
      click: () => {
        setActiveTab(tabId);
        sendMenuAction('find-all');
      }
    },
    {
      // The inline editor lives in the sidebar; the menu only asks for it, so
      // renaming behaves exactly like double-clicking the label.
      label: 'Rename…',
      click: () => sendToRenderer(IPC_CHANNELS.tabRenameRequest, { tabId })
    },
    { type: 'separator' },
    {
      label: 'Allow shared Google sign-in',
      type: 'checkbox',
      checked: shared,
      enabled: getPreferences().reuseGoogleSignIn,
      click: () => setTabAuthSharing(tabId, !shared)
    },
    {
      label: 'Reset login info…',
      click: () => { void resetTabSession(tabId); }
    },
    {
      label: 'Import cookies…',
      click: () => sendToRenderer(IPC_CHANNELS.cookiesImportRequest, { tabId })
    },
    {
      // The stored Google session answers sign-ins automatically. This is the
      // deliberate way out: finish this one in the browser, where another
      // account can be chosen, and take whatever session appears there.
      label: 'Sign in via Safari (another account)…',
      enabled: process.platform === 'darwin',
      click: () => {
        const tab = state.tabs.find(item => item.id === tabId);
        if (tab) void beginBrowserSignIn(tab, false, { skipReuse: true });
      }
    },
    { type: 'separator' },
    {
      label: 'Settings…',
      accelerator: 'CmdOrCtrl+,',
      click: () => sendMenuAction('settings')
    },
    {
      label: 'Close service',
      accelerator: 'CmdOrCtrl+W',
      click: () => removeTab(tabId)
    }
  ]);

  menu.popup({ window: mainWindow });
}

// ── External links / auth popups ─────────────────────────────────────
function openExternalSafe(url: string): void {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      void shell.openExternal(url);
    }
  } catch { /* ignore invalid URLs */ }
}

/**
 * A click on a media file has to save the file, not replace the page with a
 * player. Chromium ignores the HTML `download` attribute for cross-origin URLs
 * (the click becomes a navigation), and `window.open` of a CDN video fails the
 * "service's own host" check, so the download used to end up either as a player
 * in the tab or in the system browser. Both look like "the app will not let me
 * download this video".
 */
function startMediaDownload(contents: WebContents, url: string): void {
  if (contents.isDestroyed()) return;
  try {
    // Downloads in this page's session, so cookies and the referrer are sent.
    contents.downloadURL(url);
  } catch {
    openExternalSafe(url);
  }
}

const AUTH_HOSTS = [
  'accounts.google.com',
  'accounts.youtube.com',
  'myaccount.google.com',
  'login.microsoftonline.com',
  'login.live.com',
  'login.microsoft.com',
  'appleid.apple.com',
  'github.com',
  'gitlab.com',
  'x.com',
  'twitter.com',
  'api.twitter.com',
  'auth0.com',
  'okta.com',
  'onelogin.com',
  'clerk.com',
  'clerk.accounts.dev',
  'clerk.dev',
  'facebook.com',
  'linkedin.com',
  'discord.com',
  'slack.com',
  'openai.com',
  'anthropic.com'
];

function hostOf(url: string): string | undefined {
  try {
    if (url.startsWith('blob:')) return hostOf(url.slice(5));
    return new URL(url).hostname || undefined;
  } catch {
    return undefined;
  }
}

function isHttpUrl(url: string): boolean {
  return /^https?:\/\//i.test(url);
}

function isAuthHost(host: string | undefined): boolean {
  if (!host) return false;
  // Clerk can live on service subdomains (auth.suno.com) as well as on
  // *.clerk.accounts.dev.
  if (host.includes('clerk')) return true;
  return AUTH_HOSTS.some(domain => host === domain || host.endsWith(`.${domain}`));
}

function sameSiteHost(host: string, serviceHost: string): boolean {
  return host === serviceHost
    || host.endsWith(`.${serviceHost}`)
    || serviceHost.endsWith(`.${host}`);
}

/**
 * Popups are allowed only when they belong to the service itself, to a known
 * sign-in provider, or are the initial `about:blank` that OAuth libraries use
 * before navigating to the provider.
 */
function isTrustedPopup(targetUrl: string, openerUrl: string): boolean {
  if (!isHttpUrl(openerUrl)) return false;
  if (targetUrl === 'about:blank' || targetUrl === '') return true;
  if (targetUrl.startsWith('blob:')) return true;

  try {
    const target = new URL(targetUrl);
    if (target.protocol !== 'http:' && target.protocol !== 'https:') return false;
    const opener = new URL(openerUrl);
    if (!opener.hostname) return false;
    if (sameSiteHost(target.hostname, opener.hostname)) return true;
    return isAuthHost(target.hostname);
  } catch {
    return false;
  }
}

// ── OAuth return detection ───────────────────────────────────────────
interface AuthTracking {
  serviceHost?: string;
  sawAuth: boolean;
  reloadScheduled: boolean;
  lastReloadAt?: number;
}

const authTracking = new WeakMap<WebContents, AuthTracking>();

function trackingFor(contents: WebContents): AuthTracking {
  const existing = authTracking.get(contents);
  if (existing) return existing;
  const created: AuthTracking = { sawAuth: false, reloadScheduled: false };
  authTracking.set(contents, created);
  return created;
}

/**
 * Reload a tab once an OAuth round-trip is over. Some SPAs (notably Grok)
 * finish the cross-origin sign-in but leave the tab on a blank document until
 * it is reloaded.
 */
function scheduleReloadAfterAuth(contents: WebContents, tracking: AuthTracking): void {
  if (tracking.reloadScheduled) return;
  // Guard against a service that bounces between its domain and the sign-in
  // provider in a loop (for example an interrupted login).
  if (tracking.lastReloadAt && Date.now() - tracking.lastReloadAt < 10000) return;
  tracking.reloadScheduled = true;
  tracking.sawAuth = false;
  tracking.lastReloadAt = Date.now();

  const reload = (): void => {
    setTimeout(() => {
      tracking.reloadScheduled = false;
      if (contents.isDestroyed()) return;
      const host = hostOf(contents.getURL());
      if (!host || isAuthHost(host)) return;
      contents.reload();
      void syncGoogleFromSession(contents.session);
    }, 1500);
  };

  if (contents.isLoading()) contents.once('did-stop-loading', reload);
  else reload();
}

function markAuthNavigation(contents: WebContents, url: string): void {
  if (contents.isDestroyed() || !isHttpUrl(url)) return;
  const host = hostOf(url);
  if (!host) return;

  const tracking = trackingFor(contents);
  if (!tracking.serviceHost) tracking.serviceHost = host;
  if (host === tracking.serviceHost) return;

  if (isAuthHost(host)) {
    tracking.sawAuth = true;
    return;
  }

  if (tracking.sawAuth && tracking.serviceHost && sameSiteHost(host, tracking.serviceHost)) {
    scheduleReloadAfterAuth(contents, tracking);
  }
}

function trackAuthPopup(opener: WebContents, popup: BrowserWindow): void {
  if (opener.getType() !== 'webview' || opener.isDestroyed()) return;

  const serviceHost = hostOf(opener.getURL()) ?? trackingFor(opener).serviceHost;
  const openerUrlAtStart = opener.getURL();
  let sawAuth = false;
  let reloadScheduled = false;
  let checked = false;

  const checkAndReload = async (): Promise<void> => {
    if (checked || opener.isDestroyed()) return;
    checked = true;

    const host = hostOf(opener.getURL());
    if (host && isAuthHost(host)) return;

    // Give OAuth libraries time to post the result back. If the page has
    // navigated or rendered its own content, leave it alone; only reload a
    // tab that is still blank (the Grok case).
    if (opener.getURL() !== openerUrlAtStart) {
      void syncGoogleFromSession(opener.session);
      return;
    }

    let blank = true;
    try {
      blank = await Promise.race([
        opener.executeJavaScript('(!document.body || document.body.innerText.trim().length < 20)') as Promise<boolean>,
        new Promise<boolean>((resolve) => setTimeout(() => resolve(true), 2000))
      ]);
    } catch {
      blank = true;
    }

    if (blank) opener.reload();
    void syncGoogleFromSession(opener.session);
  };

  const reloadOpener = (): void => {
    if (reloadScheduled) return;
    reloadScheduled = true;
    setTimeout(() => {
      if (opener.isDestroyed()) return;
      if (opener.isLoading()) {
        const timer = setTimeout(() => void checkAndReload(), 5000);
        opener.once('did-stop-loading', () => {
          clearTimeout(timer);
          void checkAndReload();
        });
      } else {
        void checkAndReload();
      }
    }, 1800);
  };

  const note = (url: string): void => {
    const host = hostOf(url);
    if (!host) return;
    if (isAuthHost(host)) {
      sawAuth = true;
      return;
    }
    if (sawAuth && serviceHost && sameSiteHost(host, serviceHost)) reloadOpener();
  };

  const popupContents = popup.webContents;
  popupContents.on('did-start-navigation', (event) => {
    if (event.isMainFrame) note(event.url);
  });
  popupContents.on('will-redirect', (_event, url) => note(url));
  popupContents.on('did-navigate', (_event, url) => note(url));
  popup.on('closed', () => { if (sawAuth) reloadOpener(); });
}

// ── Google sign-in reuse ─────────────────────────────────────────────
let googleSyncQueue: Promise<number> = Promise.resolve(0);

function enqueueGoogleSync(task: () => Promise<number>): Promise<number> {
  googleSyncQueue = googleSyncQueue.then(task, task).catch(() => 0);
  return googleSyncQueue;
}

/** Copies the Google session from a tab that just signed in to all other tabs. */
function syncGoogleFromSession(source: Electron.Session): Promise<number> {
  if (!getPreferences().reuseGoogleSignIn) return Promise.resolve(0);

  // An isolated tab is explicitly using its own account. Do not let that
  // account leak into the shared vault or the other tabs.
  const sourceTab = state.tabs.find(tab => session.fromPartition(tab.partition) === source);
  if (sourceTab?.isolatedAuth) return Promise.resolve(0);

  return enqueueGoogleSync(async () => {
    const vault = session.fromPartition(GOOGLE_SIGNIN_PARTITION);
    if (source !== vault) await copyGoogleCookies(source, vault);
    const from = (await hasGoogleSession(vault)) ? vault : source;
    if (!(await hasGoogleSession(from))) return 0;

    let copied = 0;
    for (const tab of state.tabs) {
      if (tab.isolatedAuth) continue;
      const target = session.fromPartition(tab.partition);
      if (target === from || target === source) continue;
      if (await hasGoogleSession(target)) continue;
      if (await copyGoogleCookies(from, target) > 0) {
        copied += 1;
        reloadAfterGoogleCookies(tab.id);
      }
    }
    return copied;
  });
}

/** Copies the stored Google session into tabs that do not have one yet. */
function syncGoogleFromVault(): Promise<number> {
  if (!getPreferences().reuseGoogleSignIn) return Promise.resolve(0);
  return enqueueGoogleSync(async () => {
    const vault = session.fromPartition(GOOGLE_SIGNIN_PARTITION);
    if (!(await hasGoogleSession(vault))) return 0;

    let copied = 0;
    for (const tab of state.tabs) {
      if (tab.isolatedAuth) continue;
      const target = session.fromPartition(tab.partition);
      if (target === vault || await hasGoogleSession(target)) continue;
      if (await copyGoogleCookies(vault, target) > 0) {
        copied += 1;
        // A page that was rendered before the copy keeps its signed-out state.
        reloadAfterGoogleCookies(tab.id);
      }
    }
    return copied;
  });
}

/**
 * Keeps the Google session Safari now holds in the app's own vault. The handoff
 * imports only the tab's own host, so without this a login that went through
 * Safari leaves the vault empty and the next service has to go to Safari again.
 */
async function captureGoogleVault(): Promise<void> {
  if (!getPreferences().reuseGoogleSignIn) return;

  const safari = readSafariGoogleSession();
  if (safari.cookies.length === 0) return;

  const stored = getPreferences().googleVaultSession;
  // A fresh sign-in rotates Google's SID, so a changed fingerprint is a new
  // session at least as often as it is another account. The vault mirrors the
  // browser: follow it instead of keeping a snapshot Safari has replaced.
  if (stored && safari.session && safari.session !== stored) {
    logBrowserSignIn('google vault refresh: Safari session changed');
  }

  try {
    const vault = session.fromPartition(GOOGLE_SIGNIN_PARTITION);
    const written = await importSafariGoogleSession(vault, safari.cookies);
    if (written === 0) return;
    if (safari.session && safari.session !== stored) savePreferences({ googleVaultSession: safari.session });
    logBrowserSignIn(`google vault updated cookies=${written}`);
    const copied = await syncGoogleFromVault();
    sendToRenderer(IPC_CHANNELS.googleSignInDone, { copied, signedIn: true });
  } catch {
    /* best effort: the handoff itself already succeeded */
  }
}

async function googleVaultState(): Promise<GoogleVaultState> {
  const vault = session.fromPartition(GOOGLE_SIGNIN_PARTITION);
  const cookies = await readGoogleCookies(vault);
  return { saved: isSignedInToGoogle(cookies), cookies: cookies.length };
}

function openGoogleSignInWindow(): void {
  if (googleSignInWindow && !googleSignInWindow.isDestroyed()) {
    googleSignInWindow.focus();
    return;
  }

  const ses = session.fromPartition(GOOGLE_SIGNIN_PARTITION);
  configurePartition(GOOGLE_SIGNIN_PARTITION);

  const window = new BrowserWindow({
    width: 640,
    height: 800,
    title: 'Sign in to Google',
    parent: mainWindow,
    autoHideMenuBar: true,
    backgroundColor: isDarkTheme() ? '#0a0e13' : '#f5f7fa',
    webPreferences: {
      preload: guestPreloadPath,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      session: ses
    }
  });

  googleSignInWindow = window;
  window.webContents.setUserAgent(chromeUserAgent);
  window.on('closed', () => {
    googleSignInWindow = undefined;
    void (async () => {
      const signedIn = await hasGoogleSession(ses);
      // Closing this window is the explicit "this is my Google account" moment,
      // so whatever login it left behind becomes the stored one. Accounts can
      // change here and several can be added, exactly like in a browser.
      const fingerprint = fingerprintGoogleSession(await readGoogleCookies(ses));
      savePreferences({ googleVaultSession: fingerprint });
      const copied = await syncGoogleFromVault();
      sendToRenderer(IPC_CHANNELS.googleSignInDone, { copied, signedIn });
    })();
  });

  void window.loadURL('https://accounts.google.com/');
}

// ── Guest web contents ───────────────────────────────────────────────
const wiredWebContents = new WeakSet<Electron.WebContents>();

function wireWebContents(contents: Electron.WebContents): void {
  if (wiredWebContents.has(contents)) return;
  wiredWebContents.add(contents);

  contents.on('will-attach-webview', (attachEvent, webPreferences, params) => {
    delete params.preload;
    delete params.preloadURL;

    webPreferences.preload = guestPreloadPath;
    // contextIsolation stays enabled; the guest preload patches the page's
    // main world via webFrame.executeJavaScript.
    webPreferences.nodeIntegration = false;
    webPreferences.sandbox = true;
    params.useragent = chromeUserAgent;

    if (!params.partition?.startsWith('persist:')) {
      attachEvent.preventDefault();
    }
  });

  const isWebview = contents.getType() === 'webview';
  const isPopup = contents.getType() === 'window' && contents.opener !== null;
  if (!isWebview && !isPopup) return;

  // A real popup (not a separate BrowserWindow) keeps `window.opener`, so
  // OAuth libraries can post the result back to the page and close themselves.
  // The old "open another BrowserWindow and deny window.open" approach broke
  // Claude's Google callback and left Grok on a blank page.
  contents.setWindowOpenHandler(({ url }) => {
    // `window.open` on a CDN media URL is a download, not a sign-in popup. The
    // host is the CDN, so it would otherwise be handed to the system browser.
    if (isDownloadableMediaUrl(url)) {
      startMediaDownload(contents, url);
      return { action: 'deny' };
    }

    if (isTrustedPopup(url, contents.getURL())) {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          width: 640,
          height: 800,
          title: 'Sign In',
          autoHideMenuBar: true,
          parent: BrowserWindow.fromWebContents(contents) ?? mainWindow,
          backgroundColor: isDarkTheme() ? '#0a0e13' : '#f5f7fa',
          webPreferences: {
            preload: guestPreloadPath,
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: true,
            webviewTag: false,
            session: contents.session
          }
        }
      };
    }

    if (isHttpUrl(url)) openExternalSafe(url);
    return { action: 'deny' };
  });

  contents.on('did-create-window', (window) => trackAuthPopup(contents, window));

  // Guests and auth popups may only navigate to http(s); anything else is
  // denied. This keeps a compromised page from loading local files or custom
  // protocol handlers.
  contents.on('will-navigate', (event, url) => {
    if (!isHttpUrl(url) && url !== 'about:blank') {
      event.preventDefault();
      return;
    }
    // "Download" links point at a CDN file; in Chromium that is a navigation,
    // which would replace the service with a bare video player. A download
    // endpoint that redirects to the file is caught on the redirect.
    if (isDownloadableMediaUrl(url)) {
      event.preventDefault();
      startMediaDownload(contents, url);
    }
  });

  contents.on('will-redirect', (event) => {
    if (!event.isMainFrame || !isDownloadableMediaUrl(event.url)) return;
    event.preventDefault();
    startMediaDownload(contents, event.url);
  });

  // The service handed the tab (or its popup) over to a sign-in provider. One
  // state machine decides what happens next (see src/main/login-flow.ts).
  contents.on('did-start-navigation', (event) => {
    if (!event.isMainFrame || !isHttpUrl(event.url)) return;
    // Test-only switch: lets a throwaway profile stay on the provider's page.
    if (process.env.ALLAI_DISABLE_AUTH_HANDOFF === '1') return;
    const host = tabHost(event.url);
    if (!isAuthHost(host)) return;
    const tab = tabForContents(contents);
    if (!tab) return;
    const fromPopup = contentsForTab(tab) !== contents;
    void loginFlow.begin(tab.id, host, fromPopup ? 'popup' : 'navigation').then(() => {
      // A popup that only hosted the provider's login has nothing left to show.
      if (fromPopup && !contents.isDestroyed()) contents.close();
    });
  });

  if (isWebview) {
    contents.on('did-start-navigation', (event) => {
      if (event.isMainFrame) markAuthNavigation(contents, event.url);
    });
    contents.on('did-navigate', (_event, url) => {
      markAuthNavigation(contents, url);
      rememberTabUrl(contents, url);
      scheduleCapture(contents);
      const tab = tabForContents(contents);
      if (tab) loginFlow.onNavigated(tab.id, url);
    });
    contents.on('did-navigate-in-page', (_event, url, isMainFrame) => {
      if (!isMainFrame) return;
      rememberTabUrl(contents, url);
      scheduleCapture(contents);
      const tab = tabForContents(contents);
      if (tab) loginFlow.onNavigated(tab.id, url);
    });
    contents.on('did-stop-loading', () => {
      markAuthNavigation(contents, contents.getURL());
      scheduleCapture(contents);
      void harvestTab(contents);
      const tab = tabForContents(contents);
      if (tab) loginFlow.onSettled(tab.id, contents.getURL(), contents.getTitle());
    });
    contents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      if (!isMainFrame) return;
      // -3 is ERR_ABORTED: our own reload or a superseded navigation, not a failure.
      if (errorCode === -3) return;
      const tab = tabForContents(contents);
      if (tab) loginFlow.onLoadFailed(tab.id, `${errorDescription || errorCode} · ${tabHost(validatedURL) ?? 'unknown'}`);
    });
  }

  contents.on('context-menu', (_event, params) => {
    const menu = new Menu();

    if (params.linkURL) {
      menu.append(new MenuItem({ label: 'Open Link in Browser', click: () => openExternalSafe(params.linkURL) }));
      menu.append(new MenuItem({ label: 'Copy Link', click: () => { void clipboard.writeText(params.linkURL); } }));
      menu.append(new MenuItem({ type: 'separator' }));
    }

    if (params.isEditable) {
      menu.append(new MenuItem({ role: 'undo' }));
      menu.append(new MenuItem({ role: 'redo' }));
      menu.append(new MenuItem({ type: 'separator' }));
      menu.append(new MenuItem({ role: 'cut' }));
      menu.append(new MenuItem({ role: 'copy' }));
      menu.append(new MenuItem({ role: 'paste' }));
      menu.append(new MenuItem({ role: 'selectAll' }));
    } else if (params.selectionText.trim()) {
      menu.append(new MenuItem({ role: 'copy' }));
    }

    if (menu.items.length > 0) menu.append(new MenuItem({ type: 'separator' }));
    menu.append(new MenuItem({
      label: 'Back',
      enabled: contents.navigationHistory.canGoBack(),
      click: () => contents.navigationHistory.goBack()
    }));
    menu.append(new MenuItem({
      label: 'Forward',
      enabled: contents.navigationHistory.canGoForward(),
      click: () => contents.navigationHistory.goForward()
    }));
    menu.append(new MenuItem({ label: 'Reload', click: () => contents.reload() }));
    menu.append(new MenuItem({ type: 'separator' }));
    menu.append(new MenuItem({
      label: 'Open Page in Browser',
      click: () => openExternalSafe(contents.getURL())
    }));

    const win = BrowserWindow.fromWebContents(contents);
    menu.popup({ window: win ?? mainWindow });
  });
}

app.on('web-contents-created', (_event, contents) => wireWebContents(contents));

// ── Application menu ─────────────────────────────────────────────────
function sendToRenderer(channel: string, ...args: unknown[]): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, ...args);
  }
}

function sendMenuAction(action: MenuAction): void {
  sendToRenderer(IPC_CHANNELS.menuAction, action);
}

function broadcastDownloads(downloads: DownloadRecord[]): void {
  sendToRenderer(IPC_CHANNELS.downloadsChanged, downloads);
}

function broadcastPreferences(preferences: Preferences): void {
  sendToRenderer(IPC_CHANNELS.preferencesChanged, preferences);
}

function rebuildMenu(): void {
  const serviceItems: MenuItemConstructorOptions[] = state.tabs.map((tab, index) => ({
    label: tab.label,
    type: 'radio',
    checked: tab.id === state.activeTabId,
    accelerator: index < 9 ? `CmdOrCtrl+${index + 1}` : undefined,
    click: () => setActiveTab(tab.id)
  }));

  if (serviceItems.length > 0) serviceItems.push({ type: 'separator' });

  serviceItems.push(
    { label: 'Add Service…', accelerator: 'CmdOrCtrl+T', click: () => sendMenuAction('add-tab') },
    { label: 'Close Service', accelerator: 'CmdOrCtrl+W', click: closeActiveTab },
    { type: 'separator' },
    { label: 'Next Service', accelerator: 'Ctrl+Tab', click: () => cycleTab(1) },
    { label: 'Previous Service', accelerator: 'Ctrl+Shift+Tab', click: () => cycleTab(-1) }
  );

  const settingsItem: MenuItemConstructorOptions = {
    label: 'Settings…',
    accelerator: 'CmdOrCtrl+,',
    click: () => sendMenuAction('settings')
  };
  const updatesItem: MenuItemConstructorOptions = {
    label: 'Check for Updates…',
    click: () => checkForUpdates(true)
  };
  const releasesItem: MenuItemConstructorOptions = {
    label: 'Releases on GitHub',
    click: () => openExternalSafe(RELEASES_URL)
  };

  // On macOS "Settings…", "Check for Updates…" and the release link belong in
  // the application menu, where users look for them (Cmd+, included).
  const appMenu: MenuItemConstructorOptions = {
    label: app.getName(),
    submenu: [
      { role: 'about' },
      { type: 'separator' },
      updatesItem,
      releasesItem,
      { type: 'separator' },
      settingsItem,
      { type: 'separator' },
      { role: 'services' },
      { type: 'separator' },
      { role: 'hide' },
      { role: 'hideOthers' },
      { role: 'unhide' },
      { type: 'separator' },
      { role: 'quit' }
    ]
  };

  const viewItems: MenuItemConstructorOptions[] = [
    { label: 'Reload Service', accelerator: 'CmdOrCtrl+R', click: () => sendMenuAction('reload') },
    { label: 'Force Reload Service', accelerator: 'CmdOrCtrl+Shift+R', click: () => sendMenuAction('force-reload') },
    { label: 'Find in Service…', accelerator: 'CmdOrCtrl+F', click: () => sendMenuAction('find') },
    { label: 'Find in All Services…', accelerator: 'CmdOrCtrl+Shift+F', click: () => sendMenuAction('find-all') },
    { label: 'Unindexed Conversations', accelerator: 'CmdOrCtrl+Shift+U', click: () => sendMenuAction('queue') },
    { label: 'Send Prompt to All Services…', accelerator: 'CmdOrCtrl+Shift+Enter', click: () => sendMenuAction('broadcast') },
    { type: 'separator' },
    { label: 'Downloads', accelerator: 'CmdOrCtrl+J', click: () => sendMenuAction('downloads') },
    ...(process.platform === 'darwin' ? [] : [settingsItem]),
    { type: 'separator' },
    { label: 'Zoom In', accelerator: 'CmdOrCtrl+Plus', click: () => sendMenuAction('zoom-in') },
    { label: 'Zoom Out', accelerator: 'CmdOrCtrl+-', click: () => sendMenuAction('zoom-out') },
    { label: 'Actual Size', accelerator: 'CmdOrCtrl+0', click: () => sendMenuAction('zoom-reset') },
    { type: 'separator' },
    { role: 'togglefullscreen' }
  ];

  const helpItems: MenuItemConstructorOptions[] = [
    ...(process.platform === 'darwin' ? [] : [updatesItem, releasesItem]),
    { label: 'Report an Issue…', click: () => openExternalSafe(ISSUES_URL) }
  ];

  const template: MenuItemConstructorOptions[] = [
    ...(process.platform === 'darwin' ? [appMenu] : []),
    { role: 'editMenu' },
    {
      label: 'Services',
      submenu: serviceItems
    },
    {
      label: 'View',
      submenu: viewItems
    },
    { role: 'windowMenu' },
    {
      role: 'help',
      submenu: helpItems
    }
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ── IPC ──────────────────────────────────────────────────────────────
function wireIpc(): void {
  ipcMain.handle(IPC_CHANNELS.appInfo, () => ({
    name: app.getName(),
    version: app.getVersion(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    platform: process.platform,
    userDataPath: app.getPath('userData')
  }));

  ipcMain.handle(IPC_CHANNELS.getState, () => state);

  ipcMain.handle(IPC_CHANNELS.addTab, (_event, input: AddTabInput) => addTab(input));

  ipcMain.handle(IPC_CHANNELS.removeTab, (_event, tabId: string) => {
    removeTab(tabId);
  });

  ipcMain.handle(IPC_CHANNELS.setActiveTab, (_event, tabId: string) => {
    setActiveTab(tabId);
  });

  ipcMain.handle(IPC_CHANNELS.reorderTabs, (_event, tabIds: string[]) => {
    const ordered = tabIds
      .map(id => state.tabs.find(tab => tab.id === id))
      .filter((tab): tab is ServiceTab => Boolean(tab));
    for (const tab of state.tabs) {
      if (!ordered.includes(tab)) ordered.push(tab);
    }
    state.tabs = ordered;
    saveState();
    broadcastState();
  });

  ipcMain.handle(IPC_CHANNELS.renameTab, (_event, tabId: string, label: string) => {
    const tab = state.tabs.find(item => item.id === tabId);
    if (!tab) return;
    const trimmed = label.trim();
    if (!trimmed) return;
    tab.label = trimmed;
    saveState();
    broadcastState();
  });

  ipcMain.handle(IPC_CHANNELS.showTabContextMenu, (_event, tabId: string) => {
    showTabContextMenu(tabId);
  });

  ipcMain.handle(IPC_CHANNELS.resetTabSession, (_event, tabId: string) => resetTabSession(tabId));

  ipcMain.handle(IPC_CHANNELS.setTabAuthSharing, (_event, tabId: string, shared: boolean) => {
    setTabAuthSharing(tabId, shared);
  });

  ipcMain.handle(IPC_CHANNELS.importCookies, async (_event, tabId: string, text: unknown) => {
    const tab = state.tabs.find(item => item.id === tabId);
    if (!tab || typeof text !== 'string') {
      return { total: 0, matched: 0, imported: 0, host: '', error: 'no-host' as const };
    }
    const host = tabHost(tab.url) || tabHost(getProviderConfig(tab.providerId).url);
    const outcome = await importCookiesIntoTab(session.fromPartition(tab.partition), host, text);
    // A reload is what makes the imported cookies take effect for the SPA.
    if (outcome.imported > 0) reloadTab(tabId);
    return outcome;
  });

  ipcMain.handle(
    IPC_CHANNELS.startBrowserSignIn,
    async (_event, tabId: string, options?: BrowserSignInOptions) => {
      const tab = state.tabs.find(item => item.id === tabId);
      if (!tab) return { ok: false, reason: 'no-tab' as const };
      if (process.platform !== 'darwin') return { ok: false, reason: 'unsupported' as const };

      return (await beginBrowserSignIn(tab, options?.passkey === true)) !== 'none'
        ? { ok: true as const }
        : { ok: false, reason: 'no-host' as const };
    }
  );

  ipcMain.handle(IPC_CHANNELS.cancelBrowserSignIn, () => {
    cancelBrowserSignIn();
  });

  ipcMain.handle(IPC_CHANNELS.getPermissionStatus, () => permissionStatus());
  ipcMain.handle(IPC_CHANNELS.openSafari, () => {
    if (process.platform === 'darwin') execFile('/usr/bin/open', ['-a', 'Safari'], () => undefined);
  });
  ipcMain.handle(IPC_CHANNELS.requestSafariControl, async () => {
    safariControlCache = await probeSafariControl();
    const status = permissionStatus();
    sendToRenderer(IPC_CHANNELS.permissionStatus, status);
    return status;
  });
  ipcMain.handle(IPC_CHANNELS.openFullDiskAccessSettings, () => {
    if (process.platform === 'darwin') void shell.openExternal(FULL_DISK_ACCESS_PANE);
  });

  // A blocked passkey request, from a <webview> or from an OAuth popup. The
  // popup shares the tab's partition, so the session identifies the tab even
  // though the popup has no webview host to talk to. The flow decides whether
  // Google can answer in the tab or the login has to go to Safari.
  ipcMain.on(IPC_CHANNELS.passkeyBlocked, (event) => {
    const tab = tabForContents(event.sender);
    if (!tab) return;
    const senderUrl = event.sender.isDestroyed() ? '' : event.sender.getURL();
    const host = hostOf(senderUrl);
    logBrowserSignIn(`passkey blocked tab=${tab.label} host=${host ?? '-'}`);
    void loginFlow.begin(tab.id, host, 'passkey');
  });

  ipcMain.handle(IPC_CHANNELS.importSafariNow, async (_event, tabId: string) => {
    const tab = state.tabs.find(item => item.id === tabId);
    if (!tab) return { imported: 0, matched: 0, host: '', error: 'none' as const };
    if (process.platform !== 'darwin') {
      return { imported: 0, matched: 0, host: '', error: 'unsupported' as const };
    }

    const target = browserSignInTarget(tab);
    const result = await importSafariSessionNow(
      session.fromPartition(tab.partition), target.host, sessionPatternFor(tab));
    logBrowserSignIn(
      `import-now tab=${tab.label} host=${target.host} imported=${result.imported}/${result.matched} `
      + `session=${result.hasSession} error=${result.error ?? '-'}`
    );
    if (result.imported > 0 && result.hasSession) navigateTab(tab.id, target.url);
    return result;
  });

  ipcMain.handle(IPC_CHANNELS.chooseCookieFile, async (): Promise<CookieFilePick> => {
    if (!mainWindow) return { canceled: true };
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Choose a cookies.txt export',
      properties: ['openFile'],
      filters: [
        { name: 'Cookie export', extensions: ['txt', 'cookies'] },
        { name: 'All files', extensions: ['*'] }
      ]
    });
    const filePath = result.filePaths[0];
    if (result.canceled || !filePath) return { canceled: true };

    const name = path.basename(filePath);
    try {
      const stat = await fs.promises.stat(filePath);
      if (stat.size > COOKIE_TEXT_MAX_BYTES) return { canceled: false, name, error: 'too-large' };
      const text = await fs.promises.readFile(filePath, 'utf8');
      return { canceled: false, name, text };
    } catch {
      return { canceled: false, name, error: 'read-failed' };
    }
  });

  ipcMain.handle(IPC_CHANNELS.openExternal, (_event, url: string) => {
    openExternalSafe(url);
  });

  ipcMain.handle(IPC_CHANNELS.searchAll, (_event, query: string) => searchTabs(state.tabs, query));

  ipcMain.handle(
    IPC_CHANNELS.openSearchResult,
    (_event, tabId: string, query: string, inList: boolean) =>
      openSearchResult(state.tabs, tabId, query, Boolean(inList))
  );

  ipcMain.handle(
    IPC_CHANNELS.broadcastPrompt,
    (_event, text: string, submit: boolean, tabIds?: string[], newChat?: boolean) => {
      const originalTabId = state.activeTabId;
      return broadcastPrompt(state.tabs, text, Boolean(submit), tabIds, newChat !== false, {
        // Submitting needs a visible, focused guest: several services ignore a
        // click while their tab is hidden. Insert-only runs stay in the
        // background and never switch tabs.
        activate: (tabId) => setActiveTab(tabId),
        originalTabId
      });
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.findInPage,
    (_event, tabId: string, query: string, options?: { forward?: boolean; findNext?: boolean }) =>
      findInTab(state.tabs, tabId, query, options)
  );

  ipcMain.handle(IPC_CHANNELS.stopAllFind, () => stopAllFind(state.tabs));

  ipcMain.handle(IPC_CHANNELS.getPreferences, () => getPreferences());

  ipcMain.handle(IPC_CHANNELS.updatePreferences, (_event, patch: Partial<Preferences>) => {
    const previous = getPreferences();
    const next = savePreferences(patch);
    broadcastPreferences(next);
    if (!next.historyIndexEnabled || !next.historyBackfillEnabled) {
      historyBackfill.stop();
    }
    if (!previous.reuseGoogleSignIn && next.reuseGoogleSignIn) {
      void (async () => {
        const signedIn = await hasGoogleSession(session.fromPartition(GOOGLE_SIGNIN_PARTITION));
        const copied = await syncGoogleFromVault();
        sendToRenderer(IPC_CHANNELS.googleSignInDone, { copied, signedIn });
      })();
    }
    if (next.syncEnabled && next.syncFolder
      && (!previous.syncEnabled || previous.syncFolder !== next.syncFolder)) {
      void historySync?.syncNow();
    } else if (previous.syncEnabled !== next.syncEnabled || previous.syncFolder !== next.syncFolder) {
      sendToRenderer(IPC_CHANNELS.syncStatus, historySync!.getStatus());
    }
    return next;
  });

  ipcMain.handle(IPC_CHANNELS.chooseDownloadDirectory, async () => {
    const result = mainWindow
      ? await dialog.showOpenDialog(mainWindow, {
        title: 'Choose download folder',
        properties: ['openDirectory', 'createDirectory']
      })
      : await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] });
    const directory = result.filePaths[0];
    if (result.canceled || !directory) return getPreferences().downloadDirectory;
    const next = savePreferences({ downloadDirectory: directory });
    broadcastPreferences(next);
    return next.downloadDirectory;
  });

  ipcMain.handle(IPC_CHANNELS.getSyncStatus, async () => {
    await historyStore.load();
    return historySync!.getStatus();
  });

  ipcMain.handle(IPC_CHANNELS.getSyncFolders, () => detectSyncFolders());

  ipcMain.handle(IPC_CHANNELS.chooseSyncFolder, async () => {
    const suggested = getPreferences().syncFolder || detectSyncFolders()[0]?.path;
    const options: Electron.OpenDialogOptions = {
      title: 'Choose a folder your cloud app synchronizes',
      defaultPath: suggested,
      buttonLabel: 'Use this folder',
      properties: ['openDirectory', 'createDirectory']
    };
    const result = mainWindow
      ? await dialog.showOpenDialog(mainWindow, options)
      : await dialog.showOpenDialog(options);
    const directory = result.filePaths[0];
    if (result.canceled || !directory) return '';

    const next = savePreferences({ syncFolder: directory, syncEnabled: true });
    broadcastPreferences(next);
    void historySync!.syncNow();
    return directory;
  });

  ipcMain.handle(IPC_CHANNELS.openSyncFolder, async () => {
    const folder = getPreferences().syncFolder;
    if (!folder) return;
    try { fs.mkdirSync(folder, { recursive: true }); } catch { /* non-fatal */ }
    await shell.openPath(folder);
  });

  ipcMain.handle(IPC_CHANNELS.syncHistoryNow, async () => {
    await historyStore.load();
    return historySync!.syncNow();
  });

  ipcMain.handle(IPC_CHANNELS.exportHistory, async () => {
    await historyStore.load();
    const stamp = new Date().toISOString().slice(0, 10);
    const options: Electron.SaveDialogOptions = {
      title: 'Export the local history index',
      defaultPath: path.join(app.getPath('downloads'), `allai-history-${stamp}.json`),
      filters: [{ name: 'ALLAI-CHAT history', extensions: ['json'] }]
    };
    const result = mainWindow
      ? await dialog.showSaveDialog(mainWindow, options)
      : await dialog.showSaveDialog(options);
    if (result.canceled || !result.filePath) return { canceled: true, entries: 0 };
    await historySync!.exportTo(result.filePath);
    const stats = historyStore.stats();
    return { canceled: false, path: result.filePath, entries: stats.entries };
  });

  ipcMain.handle(IPC_CHANNELS.importHistory, async () => {
    await historyStore.load();
    const options: Electron.OpenDialogOptions = {
      title: 'Import a history export',
      filters: [{ name: 'ALLAI-CHAT history', extensions: ['json'] }],
      properties: ['openFile']
    };
    const result = mainWindow
      ? await dialog.showOpenDialog(mainWindow, options)
      : await dialog.showOpenDialog(options);
    const file = result.filePaths[0];
    if (result.canceled || !file) {
      return {
        canceled: true, summary: '', imported: 0, upgraded: 0,
        tombstoned: 0, noTab: 0, unchanged: 0
      };
    }
    const merge = await historySync!.importFrom(file);
    if (getPreferences().syncEnabled) historySync!.schedule(1000);
    return { canceled: false, summary: describeSyncMerge(merge), ...merge };
  });

  ipcMain.handle(IPC_CHANNELS.openGoogleSignIn, () => {
    openGoogleSignInWindow();
  });

  ipcMain.handle(IPC_CHANNELS.syncGoogleSignIn, () => syncGoogleFromVault());
  ipcMain.handle(IPC_CHANNELS.getGoogleVaultState, () => googleVaultState());

  ipcMain.handle(IPC_CHANNELS.searchHistory, async (_event, query: string) => {
    await historyStore.load();
    return historyStore.search(query, 30);
  });

  ipcMain.handle(IPC_CHANNELS.searchServerHistory, async (_event, query: string) => {
    if (!query || query.trim().length < 2) return [];
    for (const tab of state.tabs) {
      const contents = contentsForTab(tab);
      if (contents && isChatGptUrl(contents.getURL())) {
        return searchChatGpt(contents, query, tab.id);
      }
    }
    return [];
  });

  ipcMain.handle(IPC_CHANNELS.estimateHistoryIndex, async (_event, tabId?: string) => {
    await historyStore.load();
    const targets = tabId
      ? state.tabs.filter(item => item.id === tabId)
      : state.tabs.filter(item => contentsForTab(item));

    const services = await Promise.all(targets.map(async (tab) => {
      // The estimate must include the local queue, not only what the visible
      // sidebar shows: older chats and project conversations are not in it.
      const indexed = historyStore.indexedChatKeys(tab.id);
      const ids = new Set(
        historyStore.unindexed(tab.id)
          .filter((entry) => {
            const key = chatKey(entry.url);
            return !key || !indexed.has(key);
          })
          .map((entry) => entry.id)
      );
      const contents = contentsForTab(tab);
      if (contents) {
        const links = await harvestTitles(contents);
        for (const link of links) {
          if (!looksLikeChatUrl(link.url)) continue;
          const key = chatKey(link.url);
          if (key && indexed.has(key)) continue;
          const existing = historyStore.get(historyId(tab.id, link.url));
          if (!existing || existing.titleOnly) ids.add(historyId(tab.id, link.url));
        }
      }
      return { tabId: tab.id, service: tab.label, candidates: ids.size };
    }));

    const candidates = services.reduce((sum, item) => sum + item.candidates, 0);
    // Rough budget: page load + settle + human pause between conversations.
    const perChatMs = 12_000;
    const betweenServicesMs = 25_000 * Math.max(0, services.length - 1);
    return { candidates, estimatedMs: candidates * perChatMs + betweenServicesMs, services };
  });

  ipcMain.handle(IPC_CHANNELS.getHistoryStats, async () => {
    await historyStore.load();
    return historyStore.stats();
  });
  ipcMain.handle(IPC_CHANNELS.getHistoryQueue, async () => {
    await historyStore.load();
    return buildQueueSnapshot();
  });
  ipcMain.handle(IPC_CHANNELS.getHistoryProgress, () => historyBackfill.getProgress());

  ipcMain.handle(IPC_CHANNELS.harvestHistory, async (_event, tabId?: string) => {
    if (tabId) {
      const tab = state.tabs.find(item => item.id === tabId);
      const contents = tab ? contentsForTab(tab) : undefined;
      return contents ? harvestTab(contents, true) : 0;
    }
    let added = 0;
    for (const tab of state.tabs) {
      const contents = contentsForTab(tab);
      if (contents) added += await harvestTab(contents, true);
    }
    return added;
  });

  ipcMain.handle(IPC_CHANNELS.startHistoryIndex, (_event, input?: string | { tabId?: string; mode?: 'full' | 'quick' }) => {
    // Fire and forget: a full run can take a long time. Progress arrives over
    // `historyProgress`, so the confirmation dialog can close immediately.
    const request = typeof input === 'string' ? { tabId: input } : input ?? {};
    const full = request.mode !== 'quick';
    if (request.tabId) void historyBackfill.start(request.tabId, { reason: 'manual', full });
    else void historyBackfill.startAll({ reason: 'manual', full });
    const tab = request.tabId
      ? state.tabs.find(item => item.id === request.tabId)
      : state.tabs.find(item => item.id === state.activeTabId);
    return { running: true, done: 0, total: 0, service: tab?.label } as const;
  });
  ipcMain.handle(IPC_CHANNELS.stopHistoryIndex, () => { historyBackfill.stop(); });

  ipcMain.handle(IPC_CHANNELS.openHistoryEntry, (_event, tabId: string, url: string) => {
    if (!isHttpUrl(url)) return;
    const tab = state.tabs.find(item => item.id === tabId);
    if (!tab) return;
    setActiveTab(tabId);
    const contents = contentsForTab(tab);
    if (contents) void contents.loadURL(url).catch(() => undefined);
  });

  ipcMain.handle(IPC_CHANNELS.forgetHistoryEntry, (_event, id: string) => {
    if (typeof id === 'string' && id.length > 0) historyStore.removeById(id);
    if (getPreferences().syncEnabled) historySync?.schedule(2000);
  });

  ipcMain.handle(IPC_CHANNELS.clearHistory, async () => {
    await historyStore.clear();
    if (getPreferences().syncEnabled) historySync?.schedule(1000);
  });

  ipcMain.handle(IPC_CHANNELS.getDownloads, () => downloadManager.list());
  ipcMain.handle(IPC_CHANNELS.cancelDownload, (_event, id: string) => downloadManager.cancel(id));
  ipcMain.handle(IPC_CHANNELS.showDownload, (_event, id: string) => downloadManager.showInFolder(id));
  ipcMain.handle(IPC_CHANNELS.openDownload, (_event, id: string) => downloadManager.open(id));
}

// ── Window ───────────────────────────────────────────────────────────
function createMainWindow(): BrowserWindow {
  const savedBounds = loadWindowBounds();
  const shotMode = process.env.ALLAI_SHOT_MODE === '1';

  const window = new BrowserWindow({
    width: savedBounds.width ?? 1440,
    height: savedBounds.height ?? 900,
    x: savedBounds.x,
    y: savedBounds.y,
    minWidth: 900,
    minHeight: 600,
    title: 'ALLAI-CHAT',
    backgroundColor: isDarkTheme() ? '#0a0e13' : '#f5f7fa',
    autoHideMenuBar: false,
    opacity: shotMode ? 0 : 1,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.cjs'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webviewTag: true
    }
  });

  if (shotMode) window.setIgnoreMouseEvents(true);

  if (savedBounds.isMaximized) window.maximize();

  // Attach hooks before the renderer creates any <webview>.
  wireWebContents(window.webContents);
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (isHttpUrl(url)) openExternalSafe(url);
    return { action: 'deny' };
  });

  window.on('close', () => saveWindowBounds(window));

  if (process.env.ELECTRON_RENDERER_URL) {
    void window.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void window.loadFile(path.join(__dirname, '../renderer/index.html'));
  }

  return window;
}

const FULL_DISK_ACCESS_PANE = 'x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles';

/**
 * Cached result of the optional Safari control probe. Unknown until the user
 * asks for it, because probing is what makes macOS show its Automation prompt.
 */
let safariControlCache: SafariControlStatus | undefined;

/**
 * Full Disk Access is the only permission the browser handoff truly needs, and
 * macOS has no "request permission" API for it, so the app can only observe it.
 * An unreadable store is the real signal (EPERM). When Safari has not written a
 * store yet the file proves nothing either way — listing its folder exercises
 * the same grant, and only when that folder is absent too is the state unknown.
 */
function safariCookieAccess(): SafariCookieAccess {
  const read = readSafariCookies();
  if (read.error === 'denied') return 'denied';
  if (read.error === 'unreadable') return 'unreadable';
  if (read.error !== 'missing') return 'ok';

  const readable = safariCookieFolderReadable();
  if (readable === true) return 'ok';
  if (readable === false) return 'denied';
  return 'missing';
}

function permissionStatus(): PermissionStatus {
  if (process.platform !== 'darwin') {
    return { safariCookies: 'unsupported', safariControl: 'unsupported' };
  }
  return { safariCookies: safariCookieAccess(), safariControl: safariControlCache ?? 'unknown' };
}

/** Brings the app to the front, also when Safari was full screen on top. */
function activateApp(): void {
  focusMainWindow();
  app.dock?.show();
  void new Promise<void>((resolve) => {
    execFile('/usr/bin/osascript', ['-e', 'tell application id "com.allaichat.app" to activate'], () => resolve());
  });
}

// ── App lifecycle ────────────────────────────────────────────────────
app.whenReady().then(() => {
  app.setAboutPanelOptions({
    applicationName: 'ALLAI-CHAT',
    applicationVersion: app.getVersion(),
    version: `Electron ${process.versions.electron}`,
    credits: 'All your AI chats in one app',
    copyright: 'MIT License'
  });

  migrateLegacyData();
  loadPreferences();
  loadState();
  void historyStore.load();
  historySync!.init();
  historySync!.start();
  configurePartition(GOOGLE_SIGNIN_PARTITION);
  for (const tab of state.tabs) configurePartition(tab.partition);

  mainWindow = createMainWindow();
  wireIpc();
  if (permissionStatus().safariCookies === 'denied') {
    console.log('[allai] Full Disk Access missing: browser sign-in cannot read Safari cookies');
  }
  // The optional Safari control is deliberately not probed here: the Apple Event
  // is what makes macOS show its Automation prompt, and that permission only
  // closes the Safari tab afterwards. It is checked from the permission dialog on
  // an explicit click, or learned from a real handoff.
  // The user may fix a grant in System Settings while the app is open.
  mainWindow.on('focus', () => {
    sendToRenderer(IPC_CHANNELS.permissionStatus, permissionStatus());
  });
  rebuildMenu();
  initAutoUpdater();
  historyReconciler.start();
  void syncGoogleFromVault();

  nativeTheme.on('updated', () => {
    const color = isDarkTheme() ? '#0a0e13' : '#f5f7fa';
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) window.setBackgroundColor(color);
    }
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      mainWindow = createMainWindow();
      rebuildMenu();
    }
  });
});

app.on('before-quit', () => {
  historyReconciler.stop();
  historyBackfill.stop();
  historySync?.stop();
  historyStore.flushSync();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
