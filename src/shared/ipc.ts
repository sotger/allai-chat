import type { AppState, ProviderId, ServiceTab } from './types';

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
  | 'next-tab'
  | 'prev-tab'
  | 'zoom-in'
  | 'zoom-out'
  | 'zoom-reset';

export interface AllaiApi {
  getAppInfo: () => Promise<AppInfo>;
  getState: () => Promise<AppState>;
  addTab: (input: AddTabInput) => Promise<ServiceTab>;
  removeTab: (tabId: string) => Promise<void>;
  setActiveTab: (tabId: string) => Promise<void>;
  reorderTabs: (tabIds: string[]) => Promise<void>;
  renameTab: (tabId: string, label: string) => Promise<void>;
  openExternal: (url: string) => Promise<void>;
  searchAll: (query: string) => Promise<SearchHit[]>;
  findInPage: (tabId: string, query: string, options?: { forward?: boolean; findNext?: boolean }) => Promise<number>;
  stopAllFind: () => Promise<void>;
  onStateChanged: (listener: (state: AppState) => void) => () => void;
  onMenuAction: (listener: (action: MenuAction) => void) => () => void;
}

export const IPC_CHANNELS = {
  appInfo: 'allai:app-info',
  getState: 'allai:get-state',
  addTab: 'allai:add-tab',
  removeTab: 'allai:remove-tab',
  setActiveTab: 'allai:set-active-tab',
  reorderTabs: 'allai:reorder-tabs',
  renameTab: 'allai:rename-tab',
  openExternal: 'allai:open-external',
  searchAll: 'allai:search-all',
  findInPage: 'allai:find-in-page',
  stopAllFind: 'allai:stop-all-find',
  stateChanged: 'allai:event:state-changed',
  menuAction: 'allai:event:menu-action'
} as const;
