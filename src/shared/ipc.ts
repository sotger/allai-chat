import type { AppState, Preferences, ProviderId, ServiceTab } from './types';

export interface SearchHit {
  tabId: string;
  matches: number;
  snippet?: string;
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

export type MenuAction =
  | 'add-tab'
  | 'close-tab'
  | 'reload'
  | 'force-reload'
  | 'find'
  | 'find-all'
  | 'downloads'
  | 'settings'
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
  findInPage: (tabId: string, query: string, options?: { forward?: boolean; findNext?: boolean }) => Promise<number>;
  stopAllFind: () => Promise<void>;
  getPreferences: () => Promise<Preferences>;
  updatePreferences: (patch: Partial<Preferences>) => Promise<Preferences>;
  chooseDownloadDirectory: () => Promise<string>;
  openGoogleSignIn: () => Promise<void>;
  syncGoogleSignIn: () => Promise<number>;
  getDownloads: () => Promise<DownloadRecord[]>;
  cancelDownload: (id: string) => Promise<void>;
  showDownload: (id: string) => Promise<void>;
  openDownload: (id: string) => Promise<void>;
  onStateChanged: (listener: (state: AppState) => void) => () => void;
  onMenuAction: (listener: (action: MenuAction) => void) => () => void;
  onPreferencesChanged: (listener: (preferences: Preferences) => void) => () => void;
  onDownloadsChanged: (listener: (downloads: DownloadRecord[]) => void) => () => void;
  onGoogleSignInDone: (listener: (result: GoogleSignInResult) => void) => () => void;
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
  findInPage: 'allai:find-in-page',
  stopAllFind: 'allai:stop-all-find',
  getPreferences: 'allai:get-preferences',
  updatePreferences: 'allai:update-preferences',
  chooseDownloadDirectory: 'allai:choose-download-directory',
  openGoogleSignIn: 'allai:open-google-sign-in',
  syncGoogleSignIn: 'allai:sync-google-sign-in',
  getDownloads: 'allai:get-downloads',
  cancelDownload: 'allai:cancel-download',
  showDownload: 'allai:show-download',
  openDownload: 'allai:open-download',
  stateChanged: 'allai:event:state-changed',
  menuAction: 'allai:event:menu-action',
  preferencesChanged: 'allai:event:preferences-changed',
  downloadsChanged: 'allai:event:downloads-changed',
  googleSignInDone: 'allai:event:google-sign-in-done'
} as const;
