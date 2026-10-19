import { useEffect, useState } from 'react';
import type { MenuAction } from '@shared/ipc';
import { AddServiceDialog } from './components/AddServiceDialog';
import { ErrorBoundary } from './components/ErrorBoundary';
import { GlobalSearch } from './components/GlobalSearch';
import { ServiceHost } from './components/ServiceHost';
import { SettingsDialog } from './components/SettingsDialog';
import { Sidebar } from './components/Sidebar';
import { useAppStore } from './store';
import { withWebview } from './webview-registry';

export default function App() {
  const isReady = useAppStore((s) => s.isReady);
  const error = useAppStore((s) => s.error);
  const notice = useAppStore((s) => s.notice);
  const setNotice = useAppStore((s) => s.setNotice);
  const bootstrap = useAppStore((s) => s.bootstrap);
  const applyState = useAppStore((s) => s.applyState);
  const setAddOpen = useAppStore((s) => s.setAddOpen);
  const setFindOpen = useAppStore((s) => s.setFindOpen);
  const setError = useAppStore((s) => s.setError);

  const [version, setVersion] = useState('');

  useEffect(() => {
    void bootstrap().catch((err: unknown) => {
      setError(err instanceof Error ? err.message : String(err));
    });
    void window.allai.getAppInfo().then((info) => setVersion(info.version)).catch(() => undefined);
  }, [bootstrap, setError]);

  useEffect(() => window.allai.onStateChanged(applyState), [applyState]);

  useEffect(() => window.allai.onPreferencesChanged((preferences) => {
    useAppStore.getState().setPreferences(preferences);
  }), []);

  useEffect(() => window.allai.onDownloadsChanged((downloads) => {
    useAppStore.getState().setDownloads(downloads);
  }), []);

  useEffect(() => window.allai.onGoogleSignInDone(({ copied, signedIn }) => {
    useAppStore.getState().setNotice(
      !signedIn
        ? 'Google sign-in window closed.'
        : copied > 0
          ? `Google sign-in copied to ${copied} service${copied === 1 ? '' : 's'}.`
          : 'Google sign-in saved.'
    );
  }), []);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(undefined), 6000);
    return () => clearTimeout(timer);
  }, [notice, setNotice]);

  useEffect(() => {
    const handleAction = (action: MenuAction): void => {
      const store = useAppStore.getState();
      const tabId = store.activeTabId;

      switch (action) {
        case 'add-tab':
          store.setAddOpen(true);
          break;
        case 'reload':
          withWebview(tabId, (wv) => wv.reload());
          break;
        case 'force-reload':
          withWebview(tabId, (wv) => wv.reloadIgnoringCache());
          break;
        case 'find':
          store.setFindOpen(true);
          break;
        case 'find-all':
          store.setGlobalFindOpen(true);
          break;
        case 'downloads':
          store.setDownloadsOpen(!store.downloadsOpen);
          break;
        case 'settings':
          store.setSettingsOpen(true);
          break;
        case 'zoom-in':
          if (tabId) store.setZoom(tabId, (store.runtime[tabId]?.zoom ?? 0) + 0.5);
          break;
        case 'zoom-out':
          if (tabId) store.setZoom(tabId, (store.runtime[tabId]?.zoom ?? 0) - 0.5);
          break;
        case 'zoom-reset':
          if (tabId) store.setZoom(tabId, 0);
          break;
        default:
          break;
      }
    };

    return window.allai.onMenuAction(handleAction);
  }, []);

  return (
    <ErrorBoundary>
      <div className="app">
        <Sidebar version={version} onAdd={() => setAddOpen(true)} />
        <main className="content">
          {isReady ? <ServiceHost onAdd={() => setAddOpen(true)} /> : <div className="loading">Loading…</div>}
        </main>
        <AddServiceDialog />
        <SettingsDialog />
        <GlobalSearch />
        {error && (
          <button className="error-toast" onClick={() => setError(undefined)} title="Dismiss">
            {error}
          </button>
        )}
        {notice && (
          <button className="notice-toast" onClick={() => setNotice(undefined)} title="Dismiss">
            {notice}
          </button>
        )}
      </div>
    </ErrorBoundary>
  );
}
