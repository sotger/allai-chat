import { useEffect, useState } from 'react';
import type { MenuAction } from '@shared/ipc';
import { AddServiceDialog } from './components/AddServiceDialog';
import { BroadcastDialog } from './components/BroadcastDialog';
import { CookiesImportDialog } from './components/CookiesImportDialog';
import { ErrorBoundary } from './components/ErrorBoundary';
import { GlobalSearch } from './components/GlobalSearch';
import { IndexConfirmDialog } from './components/IndexConfirmDialog';
import { IndexReportDialog } from './components/IndexReportDialog';
import { IndexStatusBar } from './components/IndexStatusBar';
import { QueuePanel } from './components/QueuePanel';
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
  const uiFontSize = useAppStore((s) => s.preferences.uiFontSize);
  const applyState = useAppStore((s) => s.applyState);
  const setAddOpen = useAppStore((s) => s.setAddOpen);
  const setFindOpen = useAppStore((s) => s.setFindOpen);
  const setError = useAppStore((s) => s.setError);

  const [version, setVersion] = useState('');
  const [cookiesTabId, setCookiesTabId] = useState<string>();

  useEffect(() => {
    void bootstrap().catch((err: unknown) => {
      setError(err instanceof Error ? err.message : String(err));
    });
    void window.allai.getAppInfo().then((info) => setVersion(info.version)).catch(() => undefined);
  }, [bootstrap, setError]);

  useEffect(() => window.allai.onStateChanged(applyState), [applyState]);

  // Interface text size is a single scale factor applied by CSS to every font
  // size in the app shell. Web pages keep their own zoom setting.
  useEffect(() => {
    document.documentElement.style.setProperty('--ui-scale', String(uiFontSize / 13));
  }, [uiFontSize]);

  useEffect(() => window.allai.onPreferencesChanged((preferences) => {
    useAppStore.getState().setPreferences(preferences);
  }), []);

  useEffect(() => window.allai.onDownloadsChanged((downloads) => {
    useAppStore.getState().setDownloads(downloads);
  }), []);

  useEffect(() => window.allai.onHistoryProgress((progress) => {
    useAppStore.getState().setHistoryProgress(progress);
  }), []);

  useEffect(() => window.allai.onHistoryReport((report) => {
    const store = useAppStore.getState();
    // Automatic top-ups are small and frequent: they must not interrupt with a
    // modal. The bottom bar shows progress; only failures deserve a toast.
    if (report.reason !== 'manual') {
      if (report.failures.length > 0) {
        store.setNotice(
          `Automatic indexing saved ${report.saved} conversation${report.saved === 1 ? '' : 's'}, `
          + `${report.failures.length} could not be read.`
        );
      }
      return;
    }
    store.setHistoryReport(report);
  }), []);

  useEffect(() => window.allai.onHistoryUpdated(() => {
    const store = useAppStore.getState();
    void store.refreshHistoryQueue().catch(() => undefined);
    void store.refreshHistoryStats().catch(() => undefined);
  }), []);

  useEffect(() => window.allai.onSyncStatus((status) => {
    const store = useAppStore.getState();
    store.setSyncStatus(status);
    void store.refreshHistoryStats().catch(() => undefined);
    void store.refreshHistoryQueue().catch(() => undefined);
    if (status.lastError) store.setNotice(`Cloud sync: ${status.lastError}`);
  }), []);

  useEffect(() => window.allai.onUpdateStatus((status) => {
    const store = useAppStore.getState();
    if (status.state === 'available') {
      store.setNotice(`ALLAI-CHAT ${status.version} is available.`);
    } else if (status.state === 'downloading') {
      store.setNotice(`Downloading ALLAI-CHAT ${status.version}… ${status.percent ?? 0}%`);
    } else if (status.state === 'downloaded') {
      store.setNotice(`ALLAI-CHAT ${status.version} is ready. Choose "Restart and Install".`);
    } else if (status.state === 'error') {
      store.setNotice(status.message ?? 'Update failed.');
    }
  }), []);

  const indexingRunning = useAppStore((state) => state.historyProgress.running);
  const indexingFinishedAt = useAppStore((state) => state.historyProgress.finishedAt);

  useEffect(() => {
    if (!indexingRunning) {
      void useAppStore.getState().refreshHistoryStats().catch(() => undefined);
      return;
    }
    const timer = setInterval(() => {
      void useAppStore.getState().refreshHistoryStats().catch(() => undefined);
    }, 4000);
    return () => clearInterval(timer);
  }, [indexingRunning, indexingFinishedAt]);

  useEffect(() => window.allai.onBrowserSignInResult((result) => {
    const store = useAppStore.getState();
    if (result.state === 'imported') {
      store.setNotice(`Safari session imported: ${result.imported} cookie${result.imported === 1 ? '' : 's'}.`);
    } else if (result.state === 'denied') {
      store.setNotice('macOS blocked reading Safari cookies. Grant ALLAI-CHAT Full Disk Access, or use Import cookies… from the tab context menu.');
    } else if (result.state === 'timeout') {
      store.setNotice('Safari did not hand over a session in time. Finish the sign-in there, then try again.');
    }
  }), []);

  useEffect(() => window.allai.onCookiesImportRequest(({ tabId }) => {
    const store = useAppStore.getState();
    // Importing rewrites the tab's cookies, so make that tab the visible one.
    void store.setActiveTab(tabId).catch(() => undefined);
    setCookiesTabId(tabId);
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
        case 'broadcast':
          store.setBroadcastOpen(true);
          break;
        case 'downloads':
          store.setDownloadsOpen(!store.downloadsOpen);
          break;
        case 'settings':
          store.setSettingsOpen(true);
          break;
        case 'queue':
          store.toggleQueue();
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
          <IndexStatusBar />
        </main>
        <QueuePanel />
        <AddServiceDialog />
        <SettingsDialog />
        <IndexConfirmDialog />
        <IndexReportDialog />
        <GlobalSearch />
        <BroadcastDialog />
        <CookiesImportDialog tabId={cookiesTabId} onClose={() => setCookiesTabId(undefined)} />
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
