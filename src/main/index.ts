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
import { v4 as uuid } from 'uuid';

import { IPC_CHANNELS, type AddTabInput, type DownloadRecord, type MenuAction } from '@shared/ipc';
import { getProviderConfig } from '@shared/providers';
import { createServiceTab } from '@shared/tabs';
import type { AppState, Preferences, ServiceTab } from '@shared/types';
import { DownloadManager } from './downloads';
import { GOOGLE_SIGNIN_PARTITION, copyGoogleCookies, hasGoogleSession } from './google-auth';
import { getPreferences, isDarkTheme, loadPreferences, savePreferences } from './preferences';
import { contentsForTab, findInTab, openSearchResult, searchTabs, stopAllFind } from './search';
import { broadcastPrompt } from './broadcast';
import { checkForUpdates, initAutoUpdater } from './updater';
import { HistoryBackfill } from './history/backfill';
import { capturePage, harvestTitles, titleEntry, toHistoryEntry } from './history/capture';
import { HistoryReconciler } from './history/reconcile';
import { isChatGptUrl, searchChatGpt } from './history/server-search';
import { HistoryStore } from './history/store';
import { historyId, looksLikeChatUrl } from '@shared/history';

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
  let added = 0;
  for (const link of links) {
    if (!looksLikeChatUrl(link.url)) continue;
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
      if (await copyGoogleCookies(from, target) > 0) copied += 1;
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
      if (await copyGoogleCookies(vault, target) > 0) copied += 1;
    }
    return copied;
  });
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
    if (!isHttpUrl(url) && url !== 'about:blank') event.preventDefault();
  });

  if (isWebview) {
    contents.on('did-start-navigation', (event) => {
      if (event.isMainFrame) markAuthNavigation(contents, event.url);
    });
    contents.on('did-navigate', (_event, url) => {
      markAuthNavigation(contents, url);
      rememberTabUrl(contents, url);
      scheduleCapture(contents);
    });
    contents.on('did-navigate-in-page', (_event, url, isMainFrame) => {
      if (!isMainFrame) return;
      rememberTabUrl(contents, url);
      scheduleCapture(contents);
    });
    contents.on('did-stop-loading', () => {
      markAuthNavigation(contents, contents.getURL());
      scheduleCapture(contents);
      void harvestTab(contents);
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

  const template: MenuItemConstructorOptions[] = [
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' as const }] : []),
    { role: 'editMenu' },
    {
      label: 'Services',
      submenu: serviceItems
    },
    {
      label: 'View',
      submenu: [
        { label: 'Reload Service', accelerator: 'CmdOrCtrl+R', click: () => sendMenuAction('reload') },
        { label: 'Force Reload Service', accelerator: 'CmdOrCtrl+Shift+R', click: () => sendMenuAction('force-reload') },
        { label: 'Find in Service…', accelerator: 'CmdOrCtrl+F', click: () => sendMenuAction('find') },
        { label: 'Find in All Services…', accelerator: 'CmdOrCtrl+Shift+F', click: () => sendMenuAction('find-all') },
        { label: 'Send Prompt to All Services…', accelerator: 'CmdOrCtrl+Shift+Enter', click: () => sendMenuAction('broadcast') },
        { type: 'separator' },
        { label: 'Downloads', accelerator: 'CmdOrCtrl+J', click: () => sendMenuAction('downloads') },
        { label: 'Settings…', accelerator: 'CmdOrCtrl+,', click: () => sendMenuAction('settings') },
        { type: 'separator' },
        { label: 'Zoom In', accelerator: 'CmdOrCtrl+Plus', click: () => sendMenuAction('zoom-in') },
        { label: 'Zoom Out', accelerator: 'CmdOrCtrl+-', click: () => sendMenuAction('zoom-out') },
        { label: 'Actual Size', accelerator: 'CmdOrCtrl+0', click: () => sendMenuAction('zoom-reset') },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },
    { role: 'windowMenu' },
    {
      role: 'help',
      submenu: [
        { label: 'Check for Updates…', click: () => checkForUpdates(true) },
        { label: 'Report an Issue…', click: () => openExternalSafe(ISSUES_URL) }
      ]
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
    (_event, text: string, submit: boolean, tabIds?: string[]) =>
      broadcastPrompt(state.tabs, text, Boolean(submit), tabIds)
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

  ipcMain.handle(IPC_CHANNELS.openGoogleSignIn, () => {
    openGoogleSignInWindow();
  });

  ipcMain.handle(IPC_CHANNELS.syncGoogleSignIn, () => syncGoogleFromVault());

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
    const targets = tabId
      ? state.tabs.filter(item => item.id === tabId)
      : state.tabs.filter(item => contentsForTab(item));

    const services = await Promise.all(targets.map(async (tab) => {
      const contents = contentsForTab(tab);
      if (!contents) return { tabId: tab.id, service: tab.label, candidates: 0 };
      const links = await harvestTitles(contents);
      const missing = links.filter((link) => {
        if (!looksLikeChatUrl(link.url)) return false;
        const entry = historyStore.get(historyId(tab.id, link.url));
        return !entry || entry.titleOnly;
      });
      return { tabId: tab.id, service: tab.label, candidates: missing.length };
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

  ipcMain.handle(IPC_CHANNELS.startHistoryIndex, (_event, tabId?: string) => {
    // Fire and forget: a run takes minutes. Progress arrives over
    // `historyProgress`, so the confirmation dialog can close immediately.
    if (tabId) void historyBackfill.start(tabId, { reason: 'manual' });
    else void historyBackfill.startAll({ reason: 'manual' });
    const tab = tabId
      ? state.tabs.find(item => item.id === tabId)
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

  ipcMain.handle(IPC_CHANNELS.clearHistory, async () => {
    await historyStore.clear();
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
  configurePartition(GOOGLE_SIGNIN_PARTITION);
  for (const tab of state.tabs) configurePartition(tab.partition);

  mainWindow = createMainWindow();
  wireIpc();
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
  historyStore.flushSync();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
