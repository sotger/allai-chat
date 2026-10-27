import { useEffect, useRef, useState } from 'react';
import type { ServiceTab } from '@shared/types';
import { useAppStore } from '../store';
import { webviewRegistry, withWebview } from '../webview-registry';
import { DownloadsPanel } from './DownloadsPanel';

interface ServiceWebviewProps {
  tab: ServiceTab;
  active: boolean;
}

function ServiceWebview({ tab, active }: ServiceWebviewProps) {
  const ref = useRef<Electron.WebviewTag | null>(null);
  // The persisted URL is only the initial target. Re-rendering `src` after a
  // navigation would reload the page, so it is captured once per tab.
  const startUrl = useRef(tab.url).current;
  const patchRuntime = useAppStore((s) => s.patchRuntime);
  const zoom = useAppStore((s) => s.runtime[tab.id]?.zoom ?? 0);

  useEffect(() => {
    const webview = ref.current;
    if (!webview) return;
    webviewRegistry.set(tab.id, webview);
    return () => webviewRegistry.set(tab.id, null);
  }, [tab.id]);

  useEffect(() => {
    const webview = ref.current;
    if (!webview) return;

    const updateNavigation = (): void => {
      patchRuntime(tab.id, {
        canGoBack: webview.canGoBack(),
        canGoForward: webview.canGoForward()
      });
    };

    const onStartLoading = (): void => patchRuntime(tab.id, { loading: true });
    const onStopLoading = (): void => {
      patchRuntime(tab.id, { loading: false });
      updateNavigation();
    };
    const onTitle = (event: Electron.PageTitleUpdatedEvent): void => {
      patchRuntime(tab.id, { title: event.title });
    };
    const onFavicon = (event: Electron.PageFaviconUpdatedEvent): void => {
      patchRuntime(tab.id, { favicon: event.favicons[0] });
    };
    const onNavigate = (): void => updateNavigation();

    webview.addEventListener('did-start-loading', onStartLoading);
    webview.addEventListener('did-stop-loading', onStopLoading);
    webview.addEventListener('page-title-updated', onTitle as EventListener);
    webview.addEventListener('page-favicon-updated', onFavicon as EventListener);
    webview.addEventListener('did-navigate', onNavigate);
    webview.addEventListener('did-navigate-in-page', onNavigate);

    return () => {
      webview.removeEventListener('did-start-loading', onStartLoading);
      webview.removeEventListener('did-stop-loading', onStopLoading);
      webview.removeEventListener('page-title-updated', onTitle as EventListener);
      webview.removeEventListener('page-favicon-updated', onFavicon as EventListener);
      webview.removeEventListener('did-navigate', onNavigate);
      webview.removeEventListener('did-navigate-in-page', onNavigate);
    };
  }, [tab.id, patchRuntime]);

  useEffect(() => {
    const webview = ref.current;
    if (!webview) return;

    const applyActiveState = (): void => {
      try {
        webview.setAudioMuted(!active);
        if (active) webview.focus();
      } catch { /* not dom-ready yet; retried on dom-ready */ }
    };

    const onDomReady = (): void => {
      applyActiveState();
      try {
        webview.setZoomLevel(zoom);
      } catch { /* ignore */ }
    };

    applyActiveState();
    webview.addEventListener('dom-ready', onDomReady);
    return () => { webview.removeEventListener('dom-ready', onDomReady); };
  }, [active, zoom]);

  useEffect(() => {
    try {
      ref.current?.setZoomLevel(zoom);
    } catch { /* ignore */ }
  }, [zoom]);

  return (
    <webview
      ref={ref as React.Ref<Electron.WebviewTag>}
      src={startUrl}
      partition={tab.partition}
      allowpopups={'true' as unknown as boolean}
      className={`service-webview ${active ? 'active' : ''}`}
    />
  );
}

function TopBar() {
  const tabs = useAppStore((s) => s.tabs);
  const activeTabId = useAppStore((s) => s.activeTabId);
  const runtime = useAppStore((s) => s.runtime);
  const findOpen = useAppStore((s) => s.findOpen);
  const setFindOpen = useAppStore((s) => s.setFindOpen);
  const setGlobalFindOpen = useAppStore((s) => s.setGlobalFindOpen);
  const setBroadcastOpen = useAppStore((s) => s.setBroadcastOpen);
  const openExternal = useAppStore((s) => s.openExternal);
  const downloads = useAppStore((s) => s.downloads);
  const downloadsOpen = useAppStore((s) => s.downloadsOpen);
  const setDownloadsOpen = useAppStore((s) => s.setDownloadsOpen);

  const tab = tabs.find((item) => item.id === activeTabId);
  const info = activeTabId ? runtime[activeTabId] : undefined;
  if (!tab || !activeTabId) return null;

  const activeDownloads = downloads.filter((item) => item.state === 'progressing').length;

  const webview = (): Electron.WebviewTag | undefined => webviewRegistry.get(activeTabId);

  return (
    <header className="top-bar">
      <div className="nav-group">
        <button
          className="icon-button"
          disabled={!info?.canGoBack}
          onClick={() => withWebview(activeTabId, (wv) => wv.goBack())}
          title="Back"
        >{'\u2190'}</button>
        <button
          className="icon-button"
          disabled={!info?.canGoForward}
          onClick={() => withWebview(activeTabId, (wv) => wv.goForward())}
          title="Forward"
        >{'\u2192'}</button>
        <button
          className="icon-button"
          onClick={() => withWebview(activeTabId, (wv) => (info?.loading ? wv.stop() : wv.reload()))}
          title={info?.loading ? 'Stop' : 'Reload (Cmd/Ctrl+R)'}
        >{info?.loading ? '\u00D7' : '\u21BB'}</button>
      </div>

      <div className="top-title">
        <span className="top-label" style={{ color: tab.color }}>{tab.label}</span>
        {info?.title && <span className="top-page-title">{info.title}</span>}
      </div>

      <div className="top-actions">
        <button
          className={`icon-button downloads-button ${downloadsOpen ? 'active' : ''}`}
          onClick={() => setDownloadsOpen(!downloadsOpen)}
          title="Downloads (Cmd/Ctrl+J)"
        >
          {'\u2913'}
          {activeDownloads > 0 && <span className="download-badge">{activeDownloads}</span>}
        </button>
        <button
          className="icon-button broadcast-button"
          onClick={() => setBroadcastOpen(true)}
          title="Send a prompt to all services (Cmd/Ctrl+Shift+Enter)"
        >{'\u21C9'}</button>
        <button
          className="icon-button find-all"
          onClick={() => setGlobalFindOpen(true)}
          title="Search all services (Cmd/Ctrl+Shift+F)"
        >{'\u2315'}<sup>all</sup></button>
        <button
          className={`icon-button find-page ${findOpen ? 'active' : ''}`}
          onClick={() => setFindOpen(!findOpen)}
          title="Find in page (Cmd/Ctrl+F)"
        >{'\u2315'}</button>
        <button
          className="icon-button"
          onClick={() => {
            const url = webview()?.getURL();
            if (url) void openExternal(url);
          }}
          title="Open page in system browser"
        >{'\u2197'}</button>
      </div>
    </header>
  );
}

function FindBar() {
  const open = useAppStore((s) => s.findOpen);
  const activeTabId = useAppStore((s) => s.activeTabId);
  const findQuery = useAppStore((s) => s.findQuery);
  const setFindOpen = useAppStore((s) => s.setFindOpen);
  const [query, setQuery] = useState('');
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!open) {
      withWebview(activeTabId, (wv) => wv.stopFindInPage('clearSelection'));
      setQuery('');
      return;
    }

    setQuery(findQuery);
    inputRef.current?.focus();
    inputRef.current?.select();

    if (!findQuery) return;
    const timer = setTimeout(() => {
      withWebview(activeTabId, (wv) => wv.findInPage(findQuery, { forward: true }));
    }, 160);
    return () => clearTimeout(timer);
  }, [open, findQuery, activeTabId]);

  if (!open) return null;

  const find = (forward: boolean, findNext: boolean): void => {
    if (!query) return;
    withWebview(activeTabId, (wv) => wv.findInPage(query, { forward, findNext }));
  };

  return (
    <div className="find-bar">
      <input
        ref={inputRef}
        value={query}
        placeholder="Find in page"
        onChange={(event) => {
          setQuery(event.target.value);
          if (event.target.value) {
            withWebview(activeTabId, (wv) => wv.findInPage(event.target.value, { forward: true }));
          }
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') find(!event.shiftKey, true);
          if (event.key === 'Escape') setFindOpen(false);
        }}
      />
      <button className="icon-button" onClick={() => find(false, true)} title="Previous match">{'\u2191'}</button>
      <button className="icon-button" onClick={() => find(true, true)} title="Next match">{'\u2193'}</button>
      <button className="icon-button" onClick={() => setFindOpen(false)} title="Close">{'\u00D7'}</button>
    </div>
  );
}

export function ServiceHost({ onAdd }: { onAdd: () => void }) {
  const tabs = useAppStore((s) => s.tabs);
  const activeTabId = useAppStore((s) => s.activeTabId);

  if (tabs.length === 0) {
    return (
      <div className="empty-state">
        <div className="empty-logo">
          <span className="brand-allai">ALLAI</span>
          <span className="brand-chat">CHAT</span>
        </div>
        <h1>All your AI chats in one place</h1>
        <p>
          Add ChatGPT, Claude, Gemini and others. Every service runs in its own
          isolated session with its own cookies, and switches instantly from the
          sidebar.
        </p>
        <button className="primary-button" onClick={onAdd}>+ Add your first service</button>
      </div>
    );
  }

  return (
    <div className="service-host">
      <TopBar />
      <FindBar />
      <DownloadsPanel />
      <div className="webview-stack">
        {tabs.map((tab) => (
          <ServiceWebview key={tab.id} tab={tab} active={tab.id === activeTabId} />
        ))}
      </div>
    </div>
  );
}
