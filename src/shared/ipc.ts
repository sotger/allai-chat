import type {
  HistoryEstimate,
  HistoryHit,
  HistoryProgress,
  HistoryQueueSnapshot,
  HistoryReport,
  HistoryStats,
  ServerSearchHit
} from './history';
import type { DetectedSyncFolder, SyncStatus } from './sync';
import type { AppState, Preferences, ProviderId, ServiceTab } from './types';

export interface SearchHit {
  tabId: string;
  matches: number;
  snippet?: string;
  /** True when every match comes from the service's chat list, not the page. */
  inList?: boolean;
  /** Number of characters scanned in that tab, for the "nothing found" note. */
  scanned?: number;
}

export interface BroadcastResult {
  tabId: string;
  ok: boolean;
  reason?: string;
  submitted?: boolean;
  /** The service had a fresh conversation before the text was inserted. */
  startedNewChat?: boolean;
}

export interface HistoryExportResult {
  canceled: boolean;
  path?: string;
  entries: number;
}

export interface HistoryImportResult {
  canceled: boolean;
  summary: string;
  imported: number;
  upgraded: number;
  tombstoned: number;
  noTab: number;
  unchanged: number;
}

/** Progress of the macOS fallback updater, streamed to the renderer. */
export interface UpdateStatus {
  state: 'checking' | 'available' | 'downloading' | 'downloaded' | 'none' | 'error';
  version?: string;
  percent?: number;
  message?: string;
}

/** Result of pasting a browser cookie export into one tab. */
export interface CookiesImportResult {
  /** Cookies found in the pasted text. */
  total: number;
  /** Cookies that belong to the tab's host. */
  matched: number;
  /** Cookies the tab's session accepted. */
  imported: number;
  host: string;
  error?: 'empty' | 'no-host' | 'too-large';
}

/** Sent when the tab context menu asks the renderer to open the import dialog. */
export interface CookiesImportRequest {
  tabId: string;
}

/** Sent when the tab context menu asks the sidebar to rename that tab. */
export interface TabRenameRequest {
  tabId: string;
}

/** A cookie file chosen by the user; the main process reads it, not the UI. */
export interface CookieFilePick {
  canceled: boolean;
  name?: string;
  text?: string;
  error?: 'too-large' | 'read-failed';
}

/**
 * "Sign in in Safari, then hand the session to the app" — macOS only.
 * `blocked` means the handoff was deliberately not started (the app answered the
 * passkey prompt itself, or a bounce loop was stopped); `message` explains why.
 */
export type BrowserSignInState = 'imported' | 'timeout' | 'denied' | 'blocked';

export interface BrowserSignInStart {
  ok: boolean;
  reason?: 'no-tab' | 'unsupported' | 'no-host';
}

/**
 * What macOS currently allows: reading Safari's cookies needs Full Disk Access.
 * `missing` means Safari has no cookie store here, so the grant cannot be
 * checked at all — it is not a failure. `unreadable` means the store exists but
 * could not be parsed, which is a Safari problem, not a permission one.
 */
export type SafariCookieAccess = 'ok' | 'denied' | 'missing' | 'unreadable' | 'unsupported';

/** Optional Safari automation: Apple Events plus Safari's JS-from-events setting. */
export type SafariControlAccess = 'unknown' | 'ok' | 'denied' | 'no-js' | 'unsupported';

export interface PermissionStatus {
  safariCookies: SafariCookieAccess;
  safariControl: SafariControlAccess;
}

/** Set `passkey` when the handoff starts from a blocked WebAuthn request. */
export interface BrowserSignInOptions {
  passkey?: boolean;
}

export interface BrowserSignInResult {
  tabId: string;
  state: BrowserSignInState;
  host?: string;
  imported?: number;
  /** User-facing explanation for `blocked`; the renderer has a default too. */
  message?: string;
}

/** Result of taking the current Safari session for a tab, on demand. */
export interface SafariImportResult {
  imported: number;
  matched: number;
  host: string;
  /** True when a session cookie (not just a device id) was among them. */
  hasSession: boolean;
  error?: 'denied' | 'missing' | 'unreadable' | 'none' | 'unsupported';
}

export interface AppInfo {
  name: string;
  version: string;
  electron: string;
  chrome: string;
  platform: string;
  userDataPath: string;
}

export interface AddTabInput {
  providerId: ProviderId;
  customUrl?: string;
  label?: string;
}

export interface StartHistoryIndexInput {
  tabId?: string;
  /** Manual runs are full by default; `quick` keeps the old per-service cap. */
  mode?: 'full' | 'quick';
}

export type MenuAction =
  | 'add-tab'
  | 'close-tab'
  | 'reload'
  | 'force-reload'
  | 'find'
  | 'find-all'
  | 'broadcast'
  | 'downloads'
  | 'settings'
  | 'queue'
  | 'next-tab'
  | 'prev-tab'
  | 'zoom-in'
  | 'zoom-out'
  | 'zoom-reset';

export type DownloadState = 'progressing' | 'completed' | 'cancelled' | 'interrupted';

export interface DownloadRecord {
  id: string;
  filename: string;
  url: string;
  savePath: string;
  state: DownloadState;
  receivedBytes: number;
  totalBytes: number;
  startedAt: number;
}

export interface GoogleSignInResult {
  /** How many service sessions received Google cookies. */
  copied: number;
  /** Whether the app-owned Google profile now has a session. */
  signedIn: boolean;
  /**
   * A login used a different Google account than the one the app has stored, so
   * the stored one was kept. Google itself allows several accounts in one
   * profile; this flag is about the profile's identity changing.
   */
  differentAccount?: boolean;
}

/** What the app's own Google vault currently holds. Never contains cookie values. */
export interface GoogleVaultState {
  saved: boolean;
  /** How many Google cookies are stored (0 when nothing is saved). */
  cookies: number;
}

export interface AllaiApi {
  getAppInfo: () => Promise<AppInfo>;
  getState: () => Promise<AppState>;
  addTab: (input: AddTabInput) => Promise<ServiceTab>;
  removeTab: (tabId: string) => Promise<void>;
  setActiveTab: (tabId: string) => Promise<void>;
  reorderTabs: (tabIds: string[]) => Promise<void>;
  renameTab: (tabId: string, label: string) => Promise<void>;
  showTabContextMenu: (tabId: string) => Promise<void>;
  resetTabSession: (tabId: string) => Promise<void>;
  setTabAuthSharing: (tabId: string, shared: boolean) => Promise<void>;
  importCookies: (tabId: string, text: string) => Promise<CookiesImportResult>;
  chooseCookieFile: () => Promise<CookieFilePick>;
  /** `options.passkey` opens the service's federated sign-in entry when known. */
  getPermissionStatus: () => Promise<PermissionStatus>;
  requestSafariControl: () => Promise<PermissionStatus>;
  openSafari: () => Promise<void>;
  openFullDiskAccessSettings: () => Promise<void>;
  startBrowserSignIn: (tabId: string, options?: BrowserSignInOptions) => Promise<BrowserSignInStart>;
  cancelBrowserSignIn: () => Promise<void>;
  importSafariNow: (tabId: string) => Promise<SafariImportResult>;
  openExternal: (url: string) => Promise<void>;
  searchAll: (query: string) => Promise<SearchHit[]>;
  openSearchResult: (tabId: string, query: string, inList: boolean) => Promise<number>;
  findInPage: (tabId: string, query: string, options?: { forward?: boolean; findNext?: boolean }) => Promise<number>;
  stopAllFind: () => Promise<void>;
  broadcastPrompt: (
    text: string,
    submit: boolean,
    tabIds?: string[],
    newChat?: boolean
  ) => Promise<BroadcastResult[]>;
  getPreferences: () => Promise<Preferences>;
  updatePreferences: (patch: Partial<Preferences>) => Promise<Preferences>;
  chooseDownloadDirectory: () => Promise<string>;
  getSyncStatus: () => Promise<SyncStatus>;
  getSyncFolders: () => Promise<DetectedSyncFolder[]>;
  chooseSyncFolder: () => Promise<string>;
  openSyncFolder: () => Promise<void>;
  syncHistoryNow: () => Promise<SyncStatus>;
  exportHistory: () => Promise<HistoryExportResult>;
  importHistory: () => Promise<HistoryImportResult>;
  openGoogleSignIn: () => Promise<void>;
  syncGoogleSignIn: () => Promise<number>;
  getGoogleVaultState: () => Promise<GoogleVaultState>;
  getDownloads: () => Promise<DownloadRecord[]>;
  cancelDownload: (id: string) => Promise<void>;
  showDownload: (id: string) => Promise<void>;
  openDownload: (id: string) => Promise<void>;
  searchHistory: (query: string) => Promise<HistoryHit[]>;
  searchServerHistory: (query: string) => Promise<ServerSearchHit[]>;
  getHistoryStats: () => Promise<HistoryStats>;
  getHistoryQueue: () => Promise<HistoryQueueSnapshot>;
  getHistoryProgress: () => Promise<HistoryProgress>;
  estimateHistoryIndex: (tabId?: string) => Promise<HistoryEstimate>;
  harvestHistory: (tabId?: string) => Promise<number>;
  startHistoryIndex: (input?: StartHistoryIndexInput) => Promise<HistoryProgress>;
  stopHistoryIndex: () => Promise<void>;
  openHistoryEntry: (tabId: string, url: string) => Promise<void>;
  forgetHistoryEntry: (id: string) => Promise<void>;
  clearHistory: () => Promise<void>;
  onStateChanged: (listener: (state: AppState) => void) => () => void;
  onMenuAction: (listener: (action: MenuAction) => void) => () => void;
  onPreferencesChanged: (listener: (preferences: Preferences) => void) => () => void;
  onDownloadsChanged: (listener: (downloads: DownloadRecord[]) => void) => () => void;
  onGoogleSignInDone: (listener: (result: GoogleSignInResult) => void) => () => void;
  onCookiesImportRequest: (listener: (request: CookiesImportRequest) => void) => () => void;
  onTabRenameRequest: (listener: (request: TabRenameRequest) => void) => () => void;
  onBrowserSignInResult: (listener: (result: BrowserSignInResult) => void) => () => void;
  onPermissionStatus: (listener: (status: PermissionStatus) => void) => () => void;
  onHistoryProgress: (listener: (progress: HistoryProgress) => void) => () => void;
  onHistoryReport: (listener: (report: HistoryReport) => void) => () => void;
  onHistoryUpdated: (listener: () => void) => () => void;
  onSyncStatus: (listener: (status: SyncStatus) => void) => () => void;
  onUpdateStatus: (listener: (status: UpdateStatus) => void) => () => void;
}

export const IPC_CHANNELS = {
  appInfo: 'allai:app-info',
  getState: 'allai:get-state',
  addTab: 'allai:add-tab',
  removeTab: 'allai:remove-tab',
  setActiveTab: 'allai:set-active-tab',
  reorderTabs: 'allai:reorder-tabs',
  renameTab: 'allai:rename-tab',
  showTabContextMenu: 'allai:show-tab-context-menu',
  resetTabSession: 'allai:reset-tab-session',
  setTabAuthSharing: 'allai:set-tab-auth-sharing',
  importCookies: 'allai:import-cookies',
  chooseCookieFile: 'allai:choose-cookie-file',
  getPermissionStatus: 'allai:get-permission-status',
  requestSafariControl: 'allai:request-safari-control',
  openSafari: 'allai:open-safari',
  openFullDiskAccessSettings: 'allai:open-full-disk-access-settings',
  startBrowserSignIn: 'allai:start-browser-sign-in',
  cancelBrowserSignIn: 'allai:cancel-browser-sign-in',
  /** Guest → main: a passkey request was blocked. Works from popups too. */
  passkeyBlocked: 'allai:passkey-blocked',
  importSafariNow: 'allai:import-safari-now',
  openExternal: 'allai:open-external',
  searchAll: 'allai:search-all',
  openSearchResult: 'allai:open-search-result',
  findInPage: 'allai:find-in-page',
  stopAllFind: 'allai:stop-all-find',
  broadcastPrompt: 'allai:broadcast-prompt',
  getPreferences: 'allai:get-preferences',
  updatePreferences: 'allai:update-preferences',
  chooseDownloadDirectory: 'allai:choose-download-directory',
  getSyncStatus: 'allai:get-sync-status',
  getSyncFolders: 'allai:get-sync-folders',
  chooseSyncFolder: 'allai:choose-sync-folder',
  openSyncFolder: 'allai:open-sync-folder',
  syncHistoryNow: 'allai:sync-history-now',
  exportHistory: 'allai:export-history',
  importHistory: 'allai:import-history',
  openGoogleSignIn: 'allai:open-google-sign-in',
  syncGoogleSignIn: 'allai:sync-google-sign-in',
  getGoogleVaultState: 'allai:get-google-vault-state',
  getDownloads: 'allai:get-downloads',
  cancelDownload: 'allai:cancel-download',
  showDownload: 'allai:show-download',
  openDownload: 'allai:open-download',
  searchHistory: 'allai:search-history',
  searchServerHistory: 'allai:search-server-history',
  getHistoryStats: 'allai:get-history-stats',
  getHistoryQueue: 'allai:get-history-queue',
  getHistoryProgress: 'allai:get-history-progress',
  estimateHistoryIndex: 'allai:estimate-history-index',
  harvestHistory: 'allai:harvest-history',
  startHistoryIndex: 'allai:start-history-index',
  stopHistoryIndex: 'allai:stop-history-index',
  openHistoryEntry: 'allai:open-history-entry',
  forgetHistoryEntry: 'allai:forget-history-entry',
  clearHistory: 'allai:clear-history',
  stateChanged: 'allai:event:state-changed',
  menuAction: 'allai:event:menu-action',
  preferencesChanged: 'allai:event:preferences-changed',
  downloadsChanged: 'allai:event:downloads-changed',
  googleSignInDone: 'allai:event:google-sign-in-done',
  cookiesImportRequest: 'allai:event:cookies-import-request',
  tabRenameRequest: 'allai:event:tab-rename-request',
  browserSignInResult: 'allai:event:browser-sign-in-result',
  permissionStatus: 'allai:event:permission-status',
  historyProgress: 'allai:event:history-progress',
  historyReport: 'allai:event:history-report',
  historyUpdated: 'allai:event:history-updated',
  syncStatus: 'allai:event:sync-status',
  updateStatus: 'allai:event:update-status'
} as const;
