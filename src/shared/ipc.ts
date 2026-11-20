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
  historyProgress: 'allai:event:history-progress',
  historyReport: 'allai:event:history-report',
  historyUpdated: 'allai:event:history-updated',
  syncStatus: 'allai:event:sync-status',
  updateStatus: 'allai:event:update-status'
} as const;
