import type { IpcRendererEvent } from 'electron';
import { contextBridge, ipcRenderer } from 'electron';

import { IPC_CHANNELS, type AllaiApi, type MenuAction } from '@shared/ipc';
import type { AppState } from '@shared/types';

const api: AllaiApi = {
  getAppInfo: () => ipcRenderer.invoke(IPC_CHANNELS.appInfo),
  getState: () => ipcRenderer.invoke(IPC_CHANNELS.getState),
  addTab: (input) => ipcRenderer.invoke(IPC_CHANNELS.addTab, input),
  removeTab: (tabId) => ipcRenderer.invoke(IPC_CHANNELS.removeTab, tabId),
  setActiveTab: (tabId) => ipcRenderer.invoke(IPC_CHANNELS.setActiveTab, tabId),
  reorderTabs: (tabIds) => ipcRenderer.invoke(IPC_CHANNELS.reorderTabs, tabIds),
  renameTab: (tabId, label) => ipcRenderer.invoke(IPC_CHANNELS.renameTab, tabId, label),
  openExternal: (url) => ipcRenderer.invoke(IPC_CHANNELS.openExternal, url),
  onStateChanged: (listener) => {
    const wrapped = (_event: IpcRendererEvent, state: AppState) => listener(state);
    ipcRenderer.on(IPC_CHANNELS.stateChanged, wrapped);
    return () => { ipcRenderer.removeListener(IPC_CHANNELS.stateChanged, wrapped); };
  },
  onMenuAction: (listener) => {
    const wrapped = (_event: IpcRendererEvent, action: MenuAction) => listener(action);
    ipcRenderer.on(IPC_CHANNELS.menuAction, wrapped);
    return () => { ipcRenderer.removeListener(IPC_CHANNELS.menuAction, wrapped); };
  }
};

contextBridge.exposeInMainWorld('allai', api);
