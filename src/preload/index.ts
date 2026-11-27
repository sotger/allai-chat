import type { IpcRendererEvent } from 'electron';
import { contextBridge, ipcRenderer } from 'electron';

import { IPC_CHANNELS, type AllaiApi, type BrowserSignInResult, type CookiesImportRequest, type DownloadRecord, type GoogleSignInResult, type MenuAction, type PermissionStatus, type TabRenameRequest, type UpdateStatus } from '@shared/ipc';
import type { HistoryProgress, HistoryReport } from '@shared/history';
import type { SyncStatus } from '@shared/sync';
import type { AppState, Preferences } from '@shared/types';

function subscribe<T>(channel: string, listener: (payload: T) => void): () => void {
  const wrapped = (_event: IpcRendererEvent, payload: T) => listener(payload);
  ipcRenderer.on(channel, wrapped);
  return () => { ipcRenderer.removeListener(channel, wrapped); };
}

const api: AllaiApi = {
  getAppInfo: () => ipcRenderer.invoke(IPC_CHANNELS.appInfo),
  getState: () => ipcRenderer.invoke(IPC_CHANNELS.getState),
  addTab: (input) => ipcRenderer.invoke(IPC_CHANNELS.addTab, input),
  removeTab: (tabId) => ipcRenderer.invoke(IPC_CHANNELS.removeTab, tabId),
  setActiveTab: (tabId) => ipcRenderer.invoke(IPC_CHANNELS.setActiveTab, tabId),
  reorderTabs: (tabIds) => ipcRenderer.invoke(IPC_CHANNELS.reorderTabs, tabIds),
  renameTab: (tabId, label) => ipcRenderer.invoke(IPC_CHANNELS.renameTab, tabId, label),
  showTabContextMenu: (tabId) => ipcRenderer.invoke(IPC_CHANNELS.showTabContextMenu, tabId),
  resetTabSession: (tabId) => ipcRenderer.invoke(IPC_CHANNELS.resetTabSession, tabId),
  setTabAuthSharing: (tabId, shared) => ipcRenderer.invoke(IPC_CHANNELS.setTabAuthSharing, tabId, shared),
  importCookies: (tabId, text) => ipcRenderer.invoke(IPC_CHANNELS.importCookies, tabId, text),
  chooseCookieFile: () => ipcRenderer.invoke(IPC_CHANNELS.chooseCookieFile),
  getPermissionStatus: () => ipcRenderer.invoke(IPC_CHANNELS.getPermissionStatus),
  requestSafariControl: () => ipcRenderer.invoke(IPC_CHANNELS.requestSafariControl),
  openSafari: () => ipcRenderer.invoke(IPC_CHANNELS.openSafari),
  openFullDiskAccessSettings: () => ipcRenderer.invoke(IPC_CHANNELS.openFullDiskAccessSettings),
  startBrowserSignIn: (tabId, options) => ipcRenderer.invoke(IPC_CHANNELS.startBrowserSignIn, tabId, options),
  cancelBrowserSignIn: () => ipcRenderer.invoke(IPC_CHANNELS.cancelBrowserSignIn),
  importSafariNow: (tabId) => ipcRenderer.invoke(IPC_CHANNELS.importSafariNow, tabId),
  openExternal: (url) => ipcRenderer.invoke(IPC_CHANNELS.openExternal, url),
  searchAll: (query) => ipcRenderer.invoke(IPC_CHANNELS.searchAll, query),
  openSearchResult: (tabId, query, inList) => ipcRenderer.invoke(IPC_CHANNELS.openSearchResult, tabId, query, inList),
  findInPage: (tabId, query, options) => ipcRenderer.invoke(IPC_CHANNELS.findInPage, tabId, query, options),
  stopAllFind: () => ipcRenderer.invoke(IPC_CHANNELS.stopAllFind),
  broadcastPrompt: (text, submit, tabIds, newChat) => ipcRenderer.invoke(IPC_CHANNELS.broadcastPrompt, text, submit, tabIds, newChat),
  getPreferences: () => ipcRenderer.invoke(IPC_CHANNELS.getPreferences),
  updatePreferences: (patch) => ipcRenderer.invoke(IPC_CHANNELS.updatePreferences, patch),
  chooseDownloadDirectory: () => ipcRenderer.invoke(IPC_CHANNELS.chooseDownloadDirectory),
  getSyncStatus: () => ipcRenderer.invoke(IPC_CHANNELS.getSyncStatus),
  getSyncFolders: () => ipcRenderer.invoke(IPC_CHANNELS.getSyncFolders),
  chooseSyncFolder: () => ipcRenderer.invoke(IPC_CHANNELS.chooseSyncFolder),
  openSyncFolder: () => ipcRenderer.invoke(IPC_CHANNELS.openSyncFolder),
  syncHistoryNow: () => ipcRenderer.invoke(IPC_CHANNELS.syncHistoryNow),
  exportHistory: () => ipcRenderer.invoke(IPC_CHANNELS.exportHistory),
  importHistory: () => ipcRenderer.invoke(IPC_CHANNELS.importHistory),
  openGoogleSignIn: () => ipcRenderer.invoke(IPC_CHANNELS.openGoogleSignIn),
  syncGoogleSignIn: () => ipcRenderer.invoke(IPC_CHANNELS.syncGoogleSignIn),
  getGoogleVaultState: () => ipcRenderer.invoke(IPC_CHANNELS.getGoogleVaultState),
  getDownloads: () => ipcRenderer.invoke(IPC_CHANNELS.getDownloads),
  cancelDownload: (id) => ipcRenderer.invoke(IPC_CHANNELS.cancelDownload, id),
  showDownload: (id) => ipcRenderer.invoke(IPC_CHANNELS.showDownload, id),
  openDownload: (id) => ipcRenderer.invoke(IPC_CHANNELS.openDownload, id),
  searchHistory: (query) => ipcRenderer.invoke(IPC_CHANNELS.searchHistory, query),
  searchServerHistory: (query) => ipcRenderer.invoke(IPC_CHANNELS.searchServerHistory, query),
  getHistoryStats: () => ipcRenderer.invoke(IPC_CHANNELS.getHistoryStats),
  getHistoryQueue: () => ipcRenderer.invoke(IPC_CHANNELS.getHistoryQueue),
  getHistoryProgress: () => ipcRenderer.invoke(IPC_CHANNELS.getHistoryProgress),
  estimateHistoryIndex: (tabId) => ipcRenderer.invoke(IPC_CHANNELS.estimateHistoryIndex, tabId),
  harvestHistory: (tabId) => ipcRenderer.invoke(IPC_CHANNELS.harvestHistory, tabId),
  startHistoryIndex: (input) => ipcRenderer.invoke(IPC_CHANNELS.startHistoryIndex, input),
  stopHistoryIndex: () => ipcRenderer.invoke(IPC_CHANNELS.stopHistoryIndex),
  openHistoryEntry: (tabId, url) => ipcRenderer.invoke(IPC_CHANNELS.openHistoryEntry, tabId, url),
  forgetHistoryEntry: (id) => ipcRenderer.invoke(IPC_CHANNELS.forgetHistoryEntry, id),
  clearHistory: () => ipcRenderer.invoke(IPC_CHANNELS.clearHistory),
  onStateChanged: (listener) => subscribe<AppState>(IPC_CHANNELS.stateChanged, listener),
  onMenuAction: (listener) => subscribe<MenuAction>(IPC_CHANNELS.menuAction, listener),
  onPreferencesChanged: (listener) => subscribe<Preferences>(IPC_CHANNELS.preferencesChanged, listener),
  onDownloadsChanged: (listener) => subscribe<DownloadRecord[]>(IPC_CHANNELS.downloadsChanged, listener),
  onGoogleSignInDone: (listener) => subscribe<GoogleSignInResult>(IPC_CHANNELS.googleSignInDone, listener),
  onCookiesImportRequest: (listener) => subscribe<CookiesImportRequest>(IPC_CHANNELS.cookiesImportRequest, listener),
  onTabRenameRequest: (listener) => subscribe<TabRenameRequest>(IPC_CHANNELS.tabRenameRequest, listener),
  onBrowserSignInResult: (listener) => subscribe<BrowserSignInResult>(IPC_CHANNELS.browserSignInResult, listener),
  onPermissionStatus: (listener) => subscribe<PermissionStatus>(IPC_CHANNELS.permissionStatus, listener),
  onHistoryProgress: (listener) => subscribe<HistoryProgress>(IPC_CHANNELS.historyProgress, listener),
  onHistoryReport: (listener) => subscribe<HistoryReport>(IPC_CHANNELS.historyReport, listener),
  onHistoryUpdated: (listener) => subscribe<unknown>(IPC_CHANNELS.historyUpdated, () => listener()),
  onSyncStatus: (listener) => subscribe<SyncStatus>(IPC_CHANNELS.syncStatus, listener),
  onUpdateStatus: (listener) => subscribe<UpdateStatus>(IPC_CHANNELS.updateStatus, listener)
};

contextBridge.exposeInMainWorld('allai', api);
