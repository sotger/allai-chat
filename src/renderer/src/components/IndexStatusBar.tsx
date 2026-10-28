import { useEffect, useState } from 'react';

import { useAppStore } from '../store';

/**
 * Thin bar at the bottom of the content area while the background indexer is
 * walking older conversations. The marquee shows the chat being read right now,
 * so a slow crawl is visibly alive instead of looking hung.
 */
export function IndexStatusBar() {
  const progress = useAppStore((state) => state.historyProgress);
  const stopHistoryIndex = useAppStore((state) => state.stopHistoryIndex);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (progress.running) {
      setVisible(true);
      return;
    }
    if (!progress.finishedAt) return;
    setVisible(true);
    const timer = setTimeout(() => setVisible(false), 7000);
    return () => clearTimeout(timer);
  }, [progress.running, progress.finishedAt]);

  if (!visible) return null;

  const percent = progress.total > 0
    ? Math.min(100, Math.round((progress.done / progress.total) * 100))
    : 0;

  const title = progress.error
    ?? progress.currentTitle
    ?? (progress.running ? 'Reading conversations…' : `Indexed ${progress.done} conversation${progress.done === 1 ? '' : 's'}`);

  return (
    <div className={`index-status ${progress.running ? 'running' : 'idle'}`} role="status" aria-live="polite">
      {progress.running
        ? <span className="tab-spinner" />
        : <span className="index-status-check">{'\u2713'}</span>}
      <span className="index-status-label">
        {progress.running
          ? `Indexing ${progress.service ?? 'history'}${progress.batchTotal && progress.batchTotal > 1
            ? ` ${progress.batchIndex ?? 1}/${progress.batchTotal}`
            : ''}`
          : progress.error ? 'Indexing paused' : 'History index'}
      </span>
      <span className="index-status-ticker">
        <span className="index-status-title" title={title}>{title}</span>
      </span>
      <span className="index-status-count">{progress.done}/{progress.total}</span>
      <span className="index-status-bar" aria-hidden="true">
        <span style={{ width: `${percent}%` }} />
      </span>
      {progress.running && (
        <button className="index-status-stop" onClick={() => void stopHistoryIndex()}>
          Stop
        </button>
      )}
    </div>
  );
}
