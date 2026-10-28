import { useEffect, useState } from 'react';

import { formatDuration, type HistoryEstimate } from '@shared/history';
import { useAppStore } from '../store';

export function IndexConfirmDialog() {
  const open = useAppStore((state) => state.indexConfirmOpen);
  const setOpen = useAppStore((state) => state.setIndexConfirmOpen);
  const startHistoryIndex = useAppStore((state) => state.startHistoryIndex);
  const preferences = useAppStore((state) => state.preferences);
  const tabs = useAppStore((state) => state.tabs);
  const activeTabId = useAppStore((state) => state.activeTabId);

  const [estimate, setEstimate] = useState<HistoryEstimate | null>(null);
  const [starting, setStarting] = useState(false);

  useEffect(() => {
    if (!open) return;
    setEstimate(null);
    setStarting(false);
    void window.allai.estimateHistoryIndex()
      .then(setEstimate)
      .catch(() => setEstimate({ candidates: 0, estimatedMs: 0 }));
  }, [open]);

  if (!open) return null;

  const tab = tabs.find((item) => item.id === activeTabId) ?? tabs[0];

  const start = async (): Promise<void> => {
    setStarting(true);
    try {
      await startHistoryIndex();
      setOpen(false);
    } finally {
      setStarting(false);
    }
  };

  return (
    <div className="modal-backdrop" onMouseDown={() => setOpen(false)}>
      <div className="modal index-confirm-modal" onMouseDown={(event) => event.stopPropagation()}>
        <div className="modal-header">
          <h2>Index chat history?</h2>
          <button className="icon-button" onClick={() => setOpen(false)} title="Close">{'\u00D7'}</button>
        </div>

        <p className="index-confirm-text">
          To make global search find <strong>every conversation</strong> in your account
          {tab ? ` on ${tab.label}` : ''}, the app will read them in the background. It runs
          in a hidden window, one chat at a time, 3–8 seconds apart, and stops immediately
          if the service shows a rate limit or a captcha.
        </p>

        <div className="index-confirm-estimate">
          {estimate === null
            ? 'Counting conversations…'
            : estimate.candidates === 0
              ? 'Everything found in the chat list is already indexed. You can still run it to re-read the sidebars.'
              : `${estimate.candidates.toLocaleString()} conversation${estimate.candidates === 1 ? '' : 's'} to read — roughly ${formatDuration(estimate.estimatedMs)}.`}
        </div>

        <p className="muted settings-hint">
          The estimate covers what the chat list shows right now; the hidden window scrolls
          further and may find a few more. Chats that fail (timeout, sign-in wall, deleted)
          are listed in the report at the end and can be added later just by opening them.
        </p>

        {!preferences.historyBackfillEnabled && (
          <p className="muted settings-hint">
            Background top-ups are switched off in Settings, so this is a one-time run:
            new chats will still be captured as you open them.
          </p>
        )}

        <div className="modal-actions">
          <button className="secondary-button" onClick={() => setOpen(false)}>Cancel</button>
          <button className="primary-button" onClick={() => void start()} disabled={starting}>
            {starting ? 'Starting…' : 'Start indexing'}
          </button>
        </div>
      </div>
    </div>
  );
}
