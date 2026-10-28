import { useEffect, useRef, useState } from 'react';

import type { HistoryHit, ServerSearchHit } from '@shared/history';
import { useAppStore } from '../store';

interface MatchResult {
  matches: number;
  snippet?: string;
  /** All matches came from the service's chat list, not the open conversation. */
  inList?: boolean;
  scanned?: number;
}

function renderSnippet(text: string, query: string) {
  const index = text.toLowerCase().indexOf(query.toLowerCase());
  if (index === -1) return text;
  return (
    <>
      {text.slice(0, index)}
      <mark>{text.slice(index, index + query.length)}</mark>
      {text.slice(index + query.length)}
    </>
  );
}

function formatAge(timestamp: number): string {
  const days = Math.floor((Date.now() - timestamp) / 86_400_000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  return `${days} days ago`;
}

export function GlobalSearch() {
  const open = useAppStore((s) => s.globalFindOpen);
  const tabs = useAppStore((s) => s.tabs);
  const historyStats = useAppStore((s) => s.historyStats);
  const indexing = useAppStore((s) => s.historyProgress.running);
  const setGlobalFindOpen = useAppStore((s) => s.setGlobalFindOpen);
  const setFindOpen = useAppStore((s) => s.setFindOpen);
  const setFindQuery = useAppStore((s) => s.setFindQuery);
  const setActiveTab = useAppStore((s) => s.setActiveTab);
  const setNotice = useAppStore((s) => s.setNotice);

  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Record<string, MatchResult>>({});
  const [historyHits, setHistoryHits] = useState<HistoryHit[]>([]);
  const [serverHits, setServerHits] = useState<ServerSearchHit[]>([]);
  const [searching, setSearching] = useState(false);
  const runToken = useRef(0);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!open) return;
    setQuery('');
    setResults({});
    setHistoryHits([]);
    setServerHits([]);
    setSearching(false);
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [open]);

  const runSearch = async (search: string): Promise<void> => {
    const token = ++runToken.current;
    setSearching(true);
    setResults({});
    setHistoryHits([]);
    setServerHits([]);
    try {
      const [hits, history] = await Promise.all([
        window.allai.searchAll(search),
        window.allai.searchHistory(search).catch(() => [] as HistoryHit[])
      ]);
      if (token !== runToken.current) return;

      const next: Record<string, MatchResult> = {};
      for (const hit of hits) {
        next[hit.tabId] = {
          matches: hit.matches,
          snippet: hit.snippet,
          inList: hit.inList,
          scanned: hit.scanned
        };
      }
      setResults(next);
      setHistoryHits(history);
    } finally {
      if (token === runToken.current) setSearching(false);
    }

    // The server-side index is slower and optional; it fills in afterwards.
    if (search.length >= 3) {
      void window.allai.searchServerHistory(search)
        .then((items) => {
          if (token === runToken.current) setServerHits(items);
        })
        .catch(() => undefined);
    }
  };

  useEffect(() => {
    if (!open) return;
    const search = query.trim();
    if (search.length < 2) {
      runToken.current++;
      setResults({});
      setHistoryHits([]);
      setServerHits([]);
      setSearching(false);
      void window.allai.stopAllFind();
      return;
    }
    const timer = setTimeout(() => void runSearch(search), 280);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, open]);

  if (!open) return null;

  const close = (): void => {
    runToken.current++;
    setGlobalFindOpen(false);
    setSearching(false);
    void window.allai.stopAllFind();
  };

  const openResult = async (tabId: string, inList: boolean | undefined): Promise<void> => {
    const search = query.trim();
    if (!search) return;
    setGlobalFindOpen(false);
    setFindQuery(search);
    setFindOpen(true);
    await setActiveTab(tabId);
    if (inList) setNotice('Opening that chat in the service…');
    await window.allai.openSearchResult(tabId, search, Boolean(inList));
  };

  const openIndexed = async (tabId: string, url: string): Promise<void> => {
    setGlobalFindOpen(false);
    await setActiveTab(tabId);
    await window.allai.openHistoryEntry(tabId, url);
  };

  const rows = tabs
    .map((tab) => ({ tab, result: results[tab.id] }))
    .filter(({ result }) => (result?.matches ?? 0) > 0)
    .sort((a, b) => (b.result?.matches ?? 0) - (a.result?.matches ?? 0));

  const missed = tabs.filter((tab) => (results[tab.id]?.matches ?? 0) === 0);
  const totalScanned = Object.values(results).reduce((sum, result) => sum + (result.scanned ?? 0), 0);
  const hasResults = rows.length > 0 || historyHits.length > 0 || serverHits.length > 0;
  const showEmpty = !searching && query.trim().length >= 2 && !hasResults;

  return (
    <div className="global-search-backdrop" onMouseDown={close}>
      <div className="global-search" onMouseDown={(event) => event.stopPropagation()}>
        <div className="global-search-head">
          <span className="global-search-icon">{'\u2315'}</span>
          <input
            ref={inputRef}
            value={query}
            placeholder="Search all services…"
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') close();
              if (event.key === 'Enter' && query.trim().length >= 2) void runSearch(query.trim());
            }}
          />
          {searching && <span className="tab-spinner" />}
          <button className="icon-button" onClick={close} title="Close">{'\u00D7'}</button>
        </div>

        <div className="global-search-hint">
          Searches your local index of captured conversations, the pages that are open
          right now, and — for ChatGPT — its own server-side history.
          {indexing && <span className="global-search-indexing"> Indexing in the background…</span>}
        </div>

        <div className="global-search-results">
          {serverHits.length > 0 && (
            <div className="global-section">
              <div className="global-section-title">From ChatGPT's own index</div>
              {serverHits.map((hit) => (
                <button
                  key={`${hit.tabId}:${hit.url}`}
                  className="global-result"
                  onClick={() => void openIndexed(hit.tabId, hit.url)}
                >
                  <span className="tab-badge" style={{ background: '#10a37f' }}>G</span>
                  <span className="global-result-body">
                    <span className="global-result-head">
                      <span className="global-result-label">{hit.title}</span>
                      <span className="global-result-tag">{hit.service}</span>
                    </span>
                    {hit.snippet && (
                      <span className="global-result-snippet">{renderSnippet(hit.snippet, query.trim())}</span>
                    )}
                  </span>
                </button>
              ))}
            </div>
          )}

          {historyHits.length > 0 && (
            <div className="global-section">
              <div className="global-section-title">
                Indexed history
                <span className="global-section-note">
                  {historyStats.entries.toLocaleString()} conversations stored locally
                </span>
              </div>
              {historyHits.slice(0, 10).map((hit) => (
                <button
                  key={hit.id}
                  className="global-result"
                  onClick={() => void openIndexed(hit.tabId, hit.url)}
                >
                  <span className="tab-badge" style={{ background: tabs.find((tab) => tab.id === hit.tabId)?.color ?? '#475569' }}>
                    {tabs.find((tab) => tab.id === hit.tabId)?.icon ?? '?'}
                  </span>
                  <span className="global-result-body">
                    <span className="global-result-head">
                      <span className="global-result-label">{hit.title}</span>
                      <span className="global-result-tag">{hit.titleOnly ? 'title only' : hit.service}</span>
                      <span className="global-result-age">{formatAge(hit.capturedAt)}</span>
                    </span>
                    {hit.snippet && (
                      <span className="global-result-snippet">{renderSnippet(hit.snippet, query.trim())}</span>
                    )}
                  </span>
                </button>
              ))}
            </div>
          )}

          {rows.length > 0 && (
            <div className="global-section">
              <div className="global-section-title">Open pages</div>
              {rows.map(({ tab, result }) => (
                <button
                  key={tab.id}
                  className="global-result"
                  onClick={() => void openResult(tab.id, result?.inList)}
                >
                  <span className="tab-badge" style={{ background: tab.color }}>{tab.icon}</span>
                  <span className="global-result-body">
                    <span className="global-result-head">
                      <span className="global-result-label">{tab.label}</span>
                      {result?.inList && <span className="global-result-tag">chat title</span>}
                      <span className="global-result-count">{result?.matches}</span>
                    </span>
                    {result?.snippet && (
                      <span className="global-result-snippet">
                        {renderSnippet(result.snippet, query.trim())}
                      </span>
                    )}
                  </span>
                </button>
              ))}
            </div>
          )}

          {showEmpty && (
            <p className="global-search-empty">
              Nothing found. {historyStats.entries === 0
                ? 'The local index is empty: conversations are indexed as you open them, and older chats can be filled in from Settings.'
                : 'Closed conversations that were never opened in this app are not in the local index yet.'}
            </p>
          )}

          {searching && !hasResults && (
            <p className="global-search-empty">Searching {tabs.length} service{tabs.length === 1 ? '' : 's'}…</p>
          )}

          {!searching && rows.length > 0 && missed.length > 0 && (
            <p className="global-search-missed">
              No matches in {missed.map((tab) => tab.label).join(', ')}.
            </p>
          )}

          {!searching && query.trim().length >= 2 && totalScanned > 0 && (
            <p className="global-search-meta">
              Scanned {totalScanned.toLocaleString()} characters across {tabs.length} open
              service{tabs.length === 1 ? '' : 's'}.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
