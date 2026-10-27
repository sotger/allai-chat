import { useEffect, useRef, useState } from 'react';
import type { BroadcastResult } from '@shared/ipc';
import { useAppStore } from '../store';

/**
 * Inserts the same prompt into every open service at once. Sending is opt-in:
 * by default the text only lands in each composer so it can be reviewed.
 */
export function BroadcastDialog() {
  const open = useAppStore((s) => s.broadcastOpen);
  const tabs = useAppStore((s) => s.tabs);
  const setBroadcastOpen = useAppStore((s) => s.setBroadcastOpen);

  const [text, setText] = useState('');
  const [send, setSend] = useState(false);
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<BroadcastResult[]>([]);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    if (!open) return;
    setText('');
    setSend(false);
    setBusy(false);
    setResults([]);
    requestAnimationFrame(() => textareaRef.current?.focus());
  }, [open]);

  if (!open) return null;

  const close = (): void => {
    if (!busy) setBroadcastOpen(false);
  };

  const run = async (): Promise<void> => {
    if (!text.trim() || busy) return;
    setBusy(true);
    setResults([]);
    try {
      const out = await window.allai.broadcastPrompt(text, send);
      setResults(out);
    } finally {
      setBusy(false);
    }
  };

  const byTab = new Map(tabs.map((tab) => [tab.id, tab]));
  const okCount = results.filter((result) => result.ok).length;
  const failed = results.filter((result) => !result.ok);

  return (
    <div className="modal-backdrop" onMouseDown={close}>
      <div className="modal broadcast-modal" onMouseDown={(event) => event.stopPropagation()}>
        <div className="modal-header">
          <h2>Send a prompt to all services</h2>
          <button className="icon-button" onClick={close} title="Close" disabled={busy}>{'\u00D7'}</button>
        </div>

        <p className="muted broadcast-hint">
          The text is inserted into the message box of every open service, each in its own
          session. By default nothing is sent — review each tab and press Enter yourself.
        </p>

        <textarea
          ref={textareaRef}
          className="broadcast-input"
          value={text}
          placeholder="Write one prompt for all services…"
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') close();
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              void run();
            }
          }}
        />

        <div className="broadcast-actions">
          <label className="settings-check broadcast-send">
            <input
              type="checkbox"
              checked={send}
              onChange={(event) => setSend(event.target.checked)}
            />
            <span>
              Also press send
              <span className="settings-help">
                Clicks each service's send button, or presses Enter when no button can be
                found. The prompt is submitted without further review.
              </span>
            </span>
          </label>

          <button
            className="primary-button"
            onClick={() => void run()}
            disabled={busy || !text.trim() || tabs.length === 0}
          >
            {busy ? 'Inserting…' : `Insert into ${tabs.length} service${tabs.length === 1 ? '' : 's'}`}
          </button>
        </div>

        {results.length > 0 && (
          <div className="broadcast-results">
            <p className="broadcast-summary">
              Inserted into {okCount} of {results.length} services
              {send ? ' and pressed send.' : '.'}
              {failed.length > 0 ? ' Some services need a manual paste.' : ''}
            </p>
            {results.map((result) => {
              const tab = byTab.get(result.tabId);
              return (
                <div key={result.tabId} className={`broadcast-row ${result.ok ? 'ok' : 'failed'}`}>
                  <span className="broadcast-status">{result.ok ? '\u2713' : '\u00D7'}</span>
                  <span className="broadcast-service">{tab?.label ?? result.tabId}</span>
                  <span className="broadcast-detail">
                    {result.ok
                      ? result.submitted ? 'inserted and sent' : 'inserted'
                      : result.reason ?? 'not inserted'}
                  </span>
                </div>
              );
            })}
          </div>
        )}

        <p className="modal-hint">
          Tip: Cmd/Ctrl+Enter inserts immediately. Sites that block scripted input may need
          a manual paste — the row will say so.
        </p>
      </div>
    </div>
  );
}
