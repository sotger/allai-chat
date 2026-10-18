import type { AddTabInput } from '@shared/ipc';
import type { AppState, ServiceTab } from '@shared/types';
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

interface AppStore {
  tabs: ServiceTab[];
  activeTabId: string | null;
  runtime: Record<string, TabRuntime>;
  isReady: boolean;
  isBusy: boolean;
  error?: string;
  addOpen: boolean;
  findOpen: boolean;

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
  setFindOpen: (open: boolean) => void;
  setError: (message?: string) => void;
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
  addOpen: false,
  findOpen: false,

  bootstrap: async () => {
    const state = await window.allai.getState();
    get().applyState(state);
    set({ isReady: true });
  },

  applyState: (state) => {
    const runtime: Record<string, TabRuntime> = {};
    for (const tab of state.tabs) {
      runtime[tab.id] = get().runtime[tab.id] ?? defaultRuntime();
    }

    const activeChanged = get().activeTabId !== state.activeTabId;

    set({
      tabs: state.tabs,
      activeTabId: state.activeTabId,
      runtime,
      findOpen: activeChanged ? false : get().findOpen
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
  setFindOpen: (open) => set({ findOpen: open }),
  setError: (message) => set({ error: message })
}));
