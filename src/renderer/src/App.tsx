import { useEffect, useState } from 'react';
import type { MenuAction } from '@shared/ipc';
import { AddServiceDialog } from './components/AddServiceDialog';
import { ErrorBoundary } from './components/ErrorBoundary';
import { GlobalSearch } from './components/GlobalSearch';
import { ServiceHost } from './components/ServiceHost';
import { Sidebar } from './components/Sidebar';
import { useAppStore } from './store';
import { withWebview } from './webview-registry';

export default function App() {
  const isReady = useAppStore((s) => s.isReady);
  const error = useAppStore((s) => s.error);
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
        <GlobalSearch />
        {error && (
          <button className="error-toast" onClick={() => setError(undefined)} title="Dismiss">
            {error}
          </button>
        )}
      </div>
    </ErrorBoundary>
  );
}
