import { useCallback, useEffect, useRef, useState } from 'react';

import type { HistoryQueueItem } from '@shared/history';
import { useAppStore } from '../store';

const QUEUE_WIDTH_KEY = 'allai.queue-width';
const DEFAULT_WIDTH = 300;
const MIN_WIDTH = 240;
const MAX_WIDTH = 460;

function clampWidth(width: number): number {
  return Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.round(width)));
}

function readWidth(): number {
  try {
    const stored = Number(localStorage.getItem(QUEUE_WIDTH_KEY));
    return Number.isFinite(stored) && stored > 0 ? clampWidth(stored) : DEFAULT_WIDTH;
  } catch {
    return DEFAULT_WIDTH;
  }
}

/**
 * Right-hand list of conversations that are known from a chat list but have no
 * body text yet. It is a view over `history/entries.jsonl`, not a second queue:
 * clicking a row opens the chat, and the capture that follows removes it.
 */
export function QueuePanel() {
  const open = useAppStore((s) => s.queueOpen);
  const setOpen = useAppStore((s) => s.setQueueOpen);
  const queue = useAppStore((s) => s.historyQueue);
  const stats = useAppStore((s) => s.historyStats);
  const progress = useAppStore((s) => s.historyProgress);
  const refreshQueue = useAppStore((s) => s.refreshHistoryQueue);
  const refreshStats = useAppStore((s) => s.refreshHistoryStats);
  const setActiveTab = useAppStore((s) => s.setActiveTab);
  const forgetHistoryEntry = useAppStore((s) => s.forgetHistoryEntry);
  const setIndexConfirmOpen = useAppStore((s) => s.setIndexConfirmOpen);
  const setNotice = useAppStore((s) => s.setNotice);

  const [width, setWidth] = useState(readWidth);
  const [resizing, setResizing] = useState(false);
  const widthRef = useRef(width);
  const [filter, setFilter] = useState('');
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [opening, setOpening] = useState<Set<string>>(new Set());
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    widthRef.current = width;
  }, [width]);

  useEffect(() => {
    if (open) void refreshQueue().catch(() => undefined);
  }, [open, refreshQueue]);

  const persistWidth = useCallback((next: number) => {
    setWidth(next);
    try { localStorage.setItem(QUEUE_WIDTH_KEY, String(next)); } catch { /* ignore */ }
  }, []);

  const startResize = (event: React.PointerEvent<HTMLDivElement>): void => {
    event.preventDefault();
    const target = event.currentTarget;
    const startX = event.clientX;
    const startWidth = widthRef.current;
    target.setPointerCapture(event.pointerId);
    setResizing(true);

    const onMove = (moveEvent: PointerEvent): void => {
      const next = clampWidth(startWidth + (startX - moveEvent.clientX));
      widthRef.current = next;
      setWidth(next);
    };

    const onUp = (): void => {
      target.releasePointerCapture(event.pointerId);
      target.removeEventListener('pointermove', onMove);
      target.removeEventListener('pointerup', onUp);
      target.removeEventListener('pointercancel', onUp);
      setResizing(false);
      persistWidth(widthRef.current);
    };

    target.addEventListener('pointermove', onMove);
    target.addEventListener('pointerup', onUp);
    target.addEventListener('pointercancel', onUp);
  };

  if (!open) return null;

  const groups = queue?.groups ?? [];
  const needle = filter.trim().toLowerCase();
  const remaining = progress.queueRemaining ?? queue?.queued ?? 0;
  const initial = progress.queueInitial ?? remaining;
  const runSaved = progress.runSaved ?? 0;
  const runFailed = progress.runFailed ?? 0;
  const percent = progress.running && initial > 0
    ? Math.max(0, Math.min(100, Math.round(((initial - remaining) / initial) * 100)))
    : 0;

  const toggleGroup = (tabId: string): void => {
    setCollapsed((previous) => {
      const next = new Set(previous);
      if (next.has(tabId)) next.delete(tabId);
      else next.add(tabId);
      return next;
    });
  };

  const openItem = async (item: HistoryQueueItem): Promise<void> => {
    setOpening((previous) => new Set(previous).add(item.id));
    await setActiveTab(item.tabId);
    await window.allai.openHistoryEntry(item.tabId, item.url);
    window.setTimeout(() => {
      setOpening((previous) => {
        const next = new Set(previous);
        next.delete(item.id);
        return next;
      });
    }, 12_000);
  };

  const refreshList = async (): Promise<void> => {
    setRefreshing(true);
    try {
      const added = await window.allai.harvestHistory();
      await Promise.all([refreshQueue(), refreshStats()]);
      setNotice(added > 0
        ? `Found ${added} new conversation${added === 1 ? '' : 's'} in the chat lists.`
        : 'No new conversations in the visible chat lists.');
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setRefreshing(false);
    }
  };

  const visibleGroups = groups
    .map((group) => ({
      ...group,
      visible: needle
        ? group.items.filter((item) => item.title.toLowerCase().includes(needle))
        : group.items
    }))
    .filter((group) => !needle || group.visible.length > 0);

  return (
    <aside
      className={`queue-panel ${resizing ? 'resizing' : ''}`}
      style={{ width, flexBasis: width }}
      aria-label="Unindexed conversations"
    >
      <div className="queue-resizer" onPointerDown={startResize} title="Drag to resize" />

      <div className="queue-head">
        <div className="queue-heading">
          <span className="queue-title">Unindexed</span>
          <span className="queue-badge">{queue?.queued ?? stats.withoutText}</span>
        </div>
        <button className="icon-button" onClick={() => setOpen(false)} title="Hide panel">{'\u00D7'}</button>
      </div>

      {progress.running ? (
        <div className="queue-progress" role="status" aria-live="polite">
          <div className="queue-progress-top">
            <span className="queue-progress-left">{remaining.toLocaleString()} left</span>
            <span className="queue-progress-saved">
              {runSaved.toLocaleString()} saved{runFailed > 0 ? ` · ${runFailed} failed` : ''}
            </span>
          </div>
          <div className="queue-progress-bar" aria-hidden="true">
            <span style={{ width: `${percent}%` }} />
          </div>
          <div className="queue-progress-now" title={progress.currentTitle}>
            {progress.service ? `${progress.service}${progress.batchTotal && progress.batchTotal > 1
              ? ` ${progress.batchIndex ?? 1}/${progress.batchTotal}`
              : ''} — ` : ''}
            {progress.error ?? progress.currentTitle ?? 'Reading conversations…'}
          </div>
          <button className="queue-progress-stop" onClick={() => void useAppStore.getState().stopHistoryIndex()}>
            Stop
          </button>
        </div>
      ) : (
        <div className="queue-summary">
          <span>{(queue?.withText ?? stats.withText).toLocaleString()} indexed</span>
          <span>{remaining.toLocaleString()} waiting</span>
        </div>
      )}

      <div className="queue-actions">
        <button
          className="queue-action primary"
          onClick={() => setIndexConfirmOpen(true)}
          disabled={progress.running || (queue?.queued ?? 0) === 0}
        >
          Index queue
        </button>
        <button
          className="queue-action"
          onClick={() => void refreshList()}
          disabled={refreshing || progress.running}
          title="Read the chat lists of all loaded services for new titles"
        >
          {refreshing ? 'Refreshing…' : 'Refresh list'}
        </button>
      </div>

      <input
        className="queue-filter"
        value={filter}
        onChange={(event) => setFilter(event.target.value)}
        placeholder="Filter titles…"
        aria-label="Filter unindexed conversations"
      />

      <div className="queue-scroll">
        {groups.length === 0 && (
          <div className="queue-empty-state">
            <strong>Nothing waiting.</strong>
            <span>Every conversation found so far has full text.</span>
            <span className="muted">
              New titles appear here after the app reads a service&apos;s chat list.
            </span>
          </div>
        )}

        {groups.length > 0 && visibleGroups.length === 0 && (
          <div className="queue-empty-state">
            <span>No titles match “{filter.trim()}”.</span>
          </div>
        )}

        {visibleGroups.map((group) => {
          const isCollapsed = collapsed.has(group.tabId);
          return (
            <section className="queue-group" key={group.tabId}>
              <button
                className="queue-group-head"
                onClick={() => toggleGroup(group.tabId)}
                aria-expanded={!isCollapsed}
              >
                <span className="tab-badge" style={{ background: group.color }}>{group.icon}</span>
                <span className="queue-group-label">{group.service}</span>
                <span className="queue-group-count">{group.queued}</span>
                <span className={`queue-chevron ${isCollapsed ? 'collapsed' : ''}`}>{'\u25BE'}</span>
              </button>

              {!isCollapsed && (
                <div className="queue-group-rows">
                  {group.visible.map((item) => {
                    const isOpening = opening.has(item.id);
                    const isReading = progress.running
                      && progress.service === group.service
                      && progress.currentTitle === item.title;
                    return (
                      <div className={`queue-row ${isReading ? 'reading' : ''}`} key={item.id}>
                        <button
                          className="queue-row-main"
                          onClick={() => void openItem(item)}
                          title={item.url}
                          disabled={isOpening}
                        >
                          {isReading || isOpening
                            ? <span className="tab-spinner queue-row-spinner" />
                            : <span className="queue-row-dot" />}
                          <span className="queue-row-title">{item.title}</span>
                        </button>
                        <button
                          className="queue-row-forget"
                          onClick={() => void forgetHistoryEntry(item.id)}
                          title="Remove from the queue"
                          aria-label={`Remove ${item.title} from the queue`}
                        >
                          {'\u00D7'}
                        </button>
                      </div>
                    );
                  })}
                  {group.queued > group.items.length && !needle && (
                    <div className="queue-more">
                      +{(group.queued - group.items.length).toLocaleString()} more in {group.service}
                    </div>
                  )}
                </div>
              )}
            </section>
          );
        })}
      </div>

      <div className="queue-foot">
        <span>{(queue?.entries ?? stats.entries).toLocaleString()} stored</span>
        <span>{queue?.queued ?? stats.withoutText} without text</span>
      </div>
    </aside>
  );
}
