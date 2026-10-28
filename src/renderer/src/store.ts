import type { AddTabInput, DownloadRecord } from '@shared/ipc';
import type { HistoryProgress, HistoryReport, HistoryStats } from '@shared/history';
import type { AppState, Preferences, ServiceTab } from '@shared/types';
import { create } from 'zustand';

export interface TabRuntime {
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  title: string;
  favicon?: string;
  zoom: number;
}

export function defaultRuntime(): TabRuntime {
  return {
    loading: false,
    canGoBack: false,
    canGoForward: false,
    title: '',
    zoom: 0
  };
}

export function defaultPreferences(): Preferences {
  return {
    theme: 'system',
    downloadDirectory: '',
    reuseGoogleSignIn: true,
    uiFontSize: 13,
    historyIndexEnabled: true,
    historyBackfillEnabled: false
  };
}

export function defaultHistoryStats(): HistoryStats {
  return { entries: 0, withText: 0, characters: 0, services: 0 };
}

export function defaultHistoryProgress(): HistoryProgress {
  return { running: false, done: 0, total: 0 };
}

interface AppStore {
  tabs: ServiceTab[];
  activeTabId: string | null;
  runtime: Record<string, TabRuntime>;
  isReady: boolean;
  isBusy: boolean;
  error?: string;
  notice?: string;
  addOpen: boolean;
  settingsOpen: boolean;
  findOpen: boolean;
  findQuery: string;
  globalFindOpen: boolean;
  broadcastOpen: boolean;
  downloadsOpen: boolean;
  downloads: DownloadRecord[];
  preferences: Preferences;
  historyStats: HistoryStats;
  historyProgress: HistoryProgress;
  indexConfirmOpen: boolean;
  historyReport: HistoryReport | null;

  bootstrap: () => Promise<void>;
  applyState: (state: AppState) => void;
  addTab: (input: AddTabInput) => Promise<void>;
  removeTab: (tabId: string) => Promise<void>;
  setActiveTab: (tabId: string) => Promise<void>;
  reorderTabs: (tabIds: string[]) => Promise<void>;
  renameTab: (tabId: string, label: string) => Promise<void>;
  openExternal: (url: string) => Promise<void>;
  patchRuntime: (tabId: string, patch: Partial<TabRuntime>) => void;
  setZoom: (tabId: string, zoom: number) => void;
  setAddOpen: (open: boolean) => void;
  setSettingsOpen: (open: boolean) => void;
  setFindOpen: (open: boolean) => void;
  setFindQuery: (query: string) => void;
  setGlobalFindOpen: (open: boolean) => void;
  setBroadcastOpen: (open: boolean) => void;
  setDownloadsOpen: (open: boolean) => void;
  setDownloads: (downloads: DownloadRecord[]) => void;
  setPreferences: (preferences: Preferences) => void;
  setHistoryStats: (stats: HistoryStats) => void;
  setHistoryProgress: (progress: HistoryProgress) => void;
  setIndexConfirmOpen: (open: boolean) => void;
  setHistoryReport: (report: HistoryReport | null) => void;
  refreshHistoryStats: () => Promise<void>;
  startHistoryIndex: (tabId?: string) => Promise<void>;
  stopHistoryIndex: () => Promise<void>;
  clearHistory: () => Promise<void>;
  updatePreferences: (patch: Partial<Preferences>) => Promise<void>;
  chooseDownloadDirectory: () => Promise<void>;
  openGoogleSignIn: () => Promise<void>;
  syncGoogleSignIn: () => Promise<void>;
  setError: (message?: string) => void;
  setNotice: (message?: string) => void;
}

async function runAction(set: (partial: Partial<AppStore>) => void, action: () => Promise<void>): Promise<void> {
  set({ isBusy: true, error: undefined });
  try {
    await action();
  } catch (error) {
    set({ error: error instanceof Error ? error.message : String(error) });
  } finally {
    set({ isBusy: false });
  }
}

export const useAppStore = create<AppStore>((set, get) => ({
  tabs: [],
  activeTabId: null,
  runtime: {},
  isReady: false,
  isBusy: false,
  error: undefined,
  notice: undefined,
  addOpen: false,
  settingsOpen: false,
  findOpen: false,
  findQuery: '',
  globalFindOpen: false,
  broadcastOpen: false,
  downloadsOpen: false,
  downloads: [],
  preferences: defaultPreferences(),
  historyStats: defaultHistoryStats(),
  historyProgress: defaultHistoryProgress(),
  indexConfirmOpen: false,
  historyReport: null,

  bootstrap: async () => {
    const [state, preferences, downloads, historyStats, historyProgress] = await Promise.all([
      window.allai.getState(),
      window.allai.getPreferences(),
      window.allai.getDownloads(),
      window.allai.getHistoryStats(),
      window.allai.getHistoryProgress()
    ]);
    get().applyState(state);
    set({ preferences, downloads, historyStats, historyProgress, isReady: true });
  },

  applyState: (state) => {
    const runtime: Record<string, TabRuntime> = {};
    for (const tab of state.tabs) {
      runtime[tab.id] = get().runtime[tab.id] ?? defaultRuntime();
    }

    set({
      tabs: state.tabs,
      activeTabId: state.activeTabId,
      runtime
    });
  },

  addTab: async (input) => {
    await runAction(set, async () => {
      const tab = await window.allai.addTab(input);
      get().applyState(await window.allai.getState());
      set({ addOpen: false, error: undefined, activeTabId: tab.id });
    });
  },

  removeTab: async (tabId) => {
    await runAction(set, async () => {
      await window.allai.removeTab(tabId);
      get().applyState(await window.allai.getState());
    });
  },

  setActiveTab: async (tabId) => {
    set({ activeTabId: tabId });
    await window.allai.setActiveTab(tabId);
  },

  reorderTabs: async (tabIds) => {
    await runAction(set, async () => {
      await window.allai.reorderTabs(tabIds);
      get().applyState(await window.allai.getState());
    });
  },

  renameTab: async (tabId, label) => {
    const trimmed = label.trim();
    if (!trimmed) return;
    await runAction(set, async () => {
      await window.allai.renameTab(tabId, trimmed);
      get().applyState(await window.allai.getState());
    });
  },

  openExternal: async (url) => {
    await window.allai.openExternal(url);
  },

  patchRuntime: (tabId, patch) => {
    set((store) => ({
      runtime: {
        ...store.runtime,
        [tabId]: { ...(store.runtime[tabId] ?? defaultRuntime()), ...patch }
      }
    }));
  },

  setZoom: (tabId, zoom) => {
    const clamped = Math.max(-4, Math.min(6, zoom));
    get().patchRuntime(tabId, { zoom: clamped });
  },

  setAddOpen: (open) => set({ addOpen: open }),
  setSettingsOpen: (open) => set({ settingsOpen: open }),
  setFindOpen: (open) => set({ findOpen: open }),
  setFindQuery: (query) => set({ findQuery: query }),
  setGlobalFindOpen: (open) => set({ globalFindOpen: open }),
  setBroadcastOpen: (open) => set({ broadcastOpen: open }),
  setDownloadsOpen: (open) => set({ downloadsOpen: open }),
  setDownloads: (downloads) => set({ downloads }),
  setPreferences: (preferences) => set({ preferences }),
  setHistoryStats: (historyStats) => set({ historyStats }),
  setHistoryProgress: (historyProgress) => set({ historyProgress }),
  setIndexConfirmOpen: (indexConfirmOpen) => set({ indexConfirmOpen }),
  setHistoryReport: (historyReport) => set({ historyReport }),

  refreshHistoryStats: async () => {
    const historyStats = await window.allai.getHistoryStats();
    set({ historyStats });
  },

  startHistoryIndex: async (tabId) => {
    const historyProgress = await window.allai.startHistoryIndex(tabId);
    set({ historyProgress });
    const historyStats = await window.allai.getHistoryStats();
    set({ historyStats });
  },

  stopHistoryIndex: async () => {
    await window.allai.stopHistoryIndex();
  },

  clearHistory: async () => {
    await window.allai.clearHistory();
    set({ historyStats: defaultHistoryStats() });
  },

  updatePreferences: async (patch) => {
    const preferences = await window.allai.updatePreferences(patch);
    set({ preferences });
  },

  chooseDownloadDirectory: async () => {
    const downloadDirectory = await window.allai.chooseDownloadDirectory();
    set((store) => ({ preferences: { ...store.preferences, downloadDirectory } }));
  },

  openGoogleSignIn: async () => {
    await window.allai.openGoogleSignIn();
  },

  syncGoogleSignIn: async () => {
    const copied = await window.allai.syncGoogleSignIn();
    set({
      notice: copied > 0
        ? `Google sign-in copied to ${copied} service${copied === 1 ? '' : 's'}.`
        : 'No service needed a new Google sign-in.'
    });
  },

  setError: (message) => set({ error: message }),
  setNotice: (message) => set({ notice: message })
}));
