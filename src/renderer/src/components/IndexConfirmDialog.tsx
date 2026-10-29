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
      .catch(() => setEstimate({ candidates: 0, estimatedMs: 0, services: [] }));
  }, [open]);

  if (!open) return null;

  const tab = tabs.find((item) => item.id === activeTabId) ?? tabs[0];
  const queuedServices = (estimate?.services ?? []).filter((item) => item.candidates > 0);
  const scope = queuedServices.length > 1
    ? `across all ${queuedServices.length} services`
    : queuedServices.length === 1
      ? `on ${queuedServices[0].service}`
      : tab ? `on ${tab.label}` : '';

  const start = async (onlyTabId?: string): Promise<void> => {
    setStarting(true);
    try {
      await startHistoryIndex(onlyTabId);
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
          To make global search find <strong>every conversation</strong> {scope}, the app
          will read them in the background. It runs in a hidden window, one chat at a time,
          3–8 seconds apart, and moves to the next service if one shows a rate limit or a
          captcha. It starts with the service you have open and then continues through the
          others.
        </p>

        <div className="index-confirm-estimate">
          {estimate === null
            ? 'Counting conversations…'
            : estimate.candidates === 0
              ? 'Nothing is waiting in the queue for these services right now.'
              : `${estimate.candidates.toLocaleString()} conversation${estimate.candidates === 1 ? '' : 's'} across ${queuedServices.length} service${queuedServices.length === 1 ? '' : 's'} — roughly ${formatDuration(estimate.estimatedMs)}.`}
          {queuedServices.length > 1 && (
            <span className="index-confirm-breakdown">
              {queuedServices.slice(0, 8).map((item) => `${item.service} ${item.candidates}`).join(' · ')}
              {queuedServices.length > 8 ? ' · …' : ''}
            </span>
          )}
        </div>

        <p className="muted settings-hint">
          The count includes conversations already waiting in the local queue — even
          ones that are no longer visible in the chat list, such as project chats —
          plus what the chat lists show right now. The hidden window may still find
          a few more. Chats that fail (timeout, sign-in wall, deleted) stay in the
          list and can be added later just by opening them.
        </p>

        {!preferences.historyBackfillEnabled && (
          <p className="muted settings-hint">
            Background top-ups are switched off in Settings, so this is a one-time run:
            new chats will still be captured as you open them.
          </p>
        )}

        <div className="modal-actions">
          {queuedServices.length > 1 && tab && (
            <button
              className="text-button"
              onClick={() => void start(tab.id)}
              disabled={starting}
            >
              Only {tab.label}
            </button>
          )}
          <button className="secondary-button" onClick={() => setOpen(false)}>Cancel</button>
          <button className="primary-button" onClick={() => void start()} disabled={starting}>
            {starting ? 'Starting…' : 'Start indexing'}
          </button>
        </div>
      </div>
    </div>
  );
}
