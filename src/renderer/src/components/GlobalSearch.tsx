import { useEffect, useRef, useState } from 'react';
import { useAppStore } from '../store';

interface MatchResult {
  matches: number;
  snippet?: string;
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

export function GlobalSearch() {
  const open = useAppStore((s) => s.globalFindOpen);
  const tabs = useAppStore((s) => s.tabs);
  const setGlobalFindOpen = useAppStore((s) => s.setGlobalFindOpen);
  const setFindOpen = useAppStore((s) => s.setFindOpen);
  const setFindQuery = useAppStore((s) => s.setFindQuery);
  const setActiveTab = useAppStore((s) => s.setActiveTab);

  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Record<string, MatchResult>>({});
  const [searching, setSearching] = useState(false);
  const runToken = useRef(0);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!open) return;
    setQuery('');
    setResults({});
    setSearching(false);
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [open]);

  const runSearch = async (search: string): Promise<void> => {
    const token = ++runToken.current;
    setSearching(true);
    setResults({});
    try {
      const hits = await window.allai.searchAll(search);
      if (token !== runToken.current) return;
      const next: Record<string, MatchResult> = {};
      for (const hit of hits) {
        next[hit.tabId] = { matches: hit.matches, snippet: hit.snippet };
      }
      setResults(next);
    } finally {
      if (token === runToken.current) setSearching(false);
    }
  };

  useEffect(() => {
    if (!open) return;
    const search = query.trim();
    if (search.length < 2) {
      runToken.current++;
      setResults({});
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

  const openResult = (tabId: string): void => {
    const search = query.trim();
    if (!search) return;
    void window.allai.findInPage(tabId, search, { forward: true });
    setGlobalFindOpen(false);
    setFindQuery(search);
    setFindOpen(true);
    void setActiveTab(tabId);
  };

  const rows = tabs
    .map((tab) => ({ tab, result: results[tab.id] }))
    .filter(({ result }) => (result?.matches ?? 0) > 0)
    .sort((a, b) => (b.result?.matches ?? 0) - (a.result?.matches ?? 0));

  const hasResults = rows.length > 0;
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
          Searches the content currently loaded in every tab. Click a result to jump to it.
        </div>

        <div className="global-search-results">
          {rows.map(({ tab, result }) => (
            <button key={tab.id} className="global-result" onClick={() => openResult(tab.id)}>
              <span className="tab-badge" style={{ background: tab.color }}>{tab.icon}</span>
              <span className="global-result-body">
                <span className="global-result-head">
                  <span className="global-result-label">{tab.label}</span>
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

          {showEmpty && (
            <p className="global-search-empty">
              No matches in the loaded pages. Conversations that are not open in a tab
              (or not loaded in the service's sidebar) cannot be searched yet.
            </p>
          )}

          {searching && !hasResults && (
            <p className="global-search-empty">Searching {tabs.length} service{tabs.length === 1 ? '' : 's'}…</p>
          )}
        </div>
      </div>
    </div>
  );
}
