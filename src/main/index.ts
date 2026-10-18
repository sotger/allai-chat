import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Menu,
  MenuItem,
  type MenuItemConstructorOptions,
  session,
  shell
} from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { v4 as uuid } from 'uuid';

import { IPC_CHANNELS, type AddTabInput, type MenuAction } from '@shared/ipc';
import { getProviderConfig } from '@shared/providers';
import { createServiceTab } from '@shared/tabs';
import type { AppState, ServiceTab } from '@shared/types';

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

app.setName('ALLAI-CHAT');
app.userAgentFallback = chromeUserAgent;

let mainWindow: BrowserWindow | undefined;

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
      state.tabs = parsed.tabs.filter((tab): tab is ServiceTab =>
        Boolean(tab && tab.id && tab.providerId && tab.url && tab.partition)
      );
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
function addTab(input: AddTabInput): ServiceTab {
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
  state.tabs.push(tab);
  state.activeTabId = tab.id;
  saveState();
  broadcastState();
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

  // The tab owned its own isolated profile — wipe it so credentials don't
  // linger on disk once the tab is gone.
  const ses = session.fromPartition(tab.partition);
  configuredPartitions.delete(tab.partition);
  void ses.clearStorageData().catch(() => undefined);
  void ses.clearCache().catch(() => undefined);
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
  'login.microsoftonline.com',
  'login.live.com',
  'appleid.apple.com',
  'github.com',
  'x.com',
  'twitter.com',
  'api.twitter.com',
  'auth0.com',
  'openai.com',
  'anthropic.com'
];

/** Only trusted sign-in hosts (or the service's own domain) get a session-sharing window. */
function isTrustedAuthUrl(targetUrl: string, currentUrl: string): boolean {
  try {
    const targetHost = new URL(targetUrl).hostname;
    const currentHost = new URL(currentUrl).hostname;
    if (!targetHost) return false;
    if (targetHost === currentHost) return true;
    if (targetHost.endsWith(`.${currentHost}`) || currentHost.endsWith(`.${targetHost}`)) return true;
    return AUTH_HOSTS.some(domain => targetHost === domain || targetHost.endsWith(`.${domain}`));
  } catch {
    return false;
  }
}
const SERVICE_DOMAINS = [
  'chatgpt.com', 'chat.openai.com', 'claude.ai', 'gemini.google.com',
  'chat.deepseek.com', 'grok.com', 'perplexity.ai', 'kimi.moonshot.cn',
  'huggingface.co', 'copilot.microsoft.com', 'chat.mistral.ai', 'you.com',
  'phind.com', 'poe.com', 'chatglm.cn'
];

function openAuthWindow(url: string, parentSession: Electron.Session, parentWindow?: BrowserWindow): void {
  const authWindow = new BrowserWindow({
    width: 620,
    height: 780,
    title: 'Sign In',
    parent: parentWindow,
    modal: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: guestPreloadPath,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      session: parentSession
    }
  });

  authWindow.webContents.setUserAgent(chromeUserAgent);
  void authWindow.loadURL(url);

  const closeWhenBack = (targetUrl: string): void => {
    if (SERVICE_DOMAINS.some(domain => targetUrl.includes(domain)) && !targetUrl.includes('accounts.google')) {
      setTimeout(() => {
        if (!authWindow.isDestroyed()) authWindow.close();
      }, 1000);
    }
  };

  authWindow.webContents.on('will-redirect', (_event, targetUrl) => closeWhenBack(targetUrl));
  authWindow.webContents.on('will-navigate', (_event, targetUrl) => closeWhenBack(targetUrl));
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

  if (contents.getType() !== 'webview') return;

  contents.setWindowOpenHandler(({ url }) => {
    if (isTrustedAuthUrl(url, contents.getURL())) {
      openAuthWindow(url, contents.session, mainWindow);
    } else {
      openExternalSafe(url);
    }
    return { action: 'deny' };
  });

  // Guests may only navigate to http(s); anything else is denied. This keeps a
  // compromised page from loading local files or custom protocol handlers.
  contents.on('will-navigate', (event, url) => {
    if (!/^https?:\/\//i.test(url)) event.preventDefault();
  });

  contents.on('context-menu', (_event, params) => {
    const menu = new Menu();

    if (params.linkURL) {
      menu.append(new MenuItem({ label: 'Open Link in Browser', click: () => openExternalSafe(params.linkURL) }));
      menu.append(new MenuItem({ label: 'Copy Link', click: () => clipboard.writeText(params.linkURL) }));
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
function sendMenuAction(action: MenuAction): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(IPC_CHANNELS.menuAction, action);
  }
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
        { type: 'separator' },
        { label: 'Zoom In', accelerator: 'CmdOrCtrl+Plus', click: () => sendMenuAction('zoom-in') },
        { label: 'Zoom Out', accelerator: 'CmdOrCtrl+-', click: () => sendMenuAction('zoom-out') },
        { label: 'Actual Size', accelerator: 'CmdOrCtrl+0', click: () => sendMenuAction('zoom-reset') },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },
    { role: 'windowMenu' }
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

  ipcMain.handle(IPC_CHANNELS.openExternal, (_event, url: string) => {
    openExternalSafe(url);
  });
}

// ── Window ───────────────────────────────────────────────────────────
function createMainWindow(): BrowserWindow {
  const savedBounds = loadWindowBounds();

  const window = new BrowserWindow({
    width: savedBounds.width ?? 1440,
    height: savedBounds.height ?? 900,
    x: savedBounds.x,
    y: savedBounds.y,
    minWidth: 900,
    minHeight: 600,
    title: 'ALLAI-CHAT',
    backgroundColor: '#0d1117',
    autoHideMenuBar: false,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.cjs'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webviewTag: true
    }
  });

  if (savedBounds.isMaximized) window.maximize();

  // Attach hooks before the renderer creates any <webview>.
  wireWebContents(window.webContents);

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
  loadState();
  for (const tab of state.tabs) configurePartition(tab.partition);

  mainWindow = createMainWindow();
  wireIpc();
  rebuildMenu();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      mainWindow = createMainWindow();
      rebuildMenu();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
