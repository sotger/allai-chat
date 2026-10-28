import { formatDuration } from '@shared/history';
import { useAppStore } from '../store';

export function IndexReportDialog() {
  const report = useAppStore((state) => state.historyReport);
  const setHistoryReport = useAppStore((state) => state.setHistoryReport);
  const setActiveTab = useAppStore((state) => state.setActiveTab);

  if (!report) return null;

  const close = (): void => setHistoryReport(null);
  const duration = formatDuration(report.finishedAt - report.startedAt);

  const openFailure = async (url: string): Promise<void> => {
    close();
    await setActiveTab(report.tabId);
    await window.allai.openHistoryEntry(report.tabId, url);
  };

  return (
    <div className="modal-backdrop" onMouseDown={close}>
      <div className="modal index-report-modal" onMouseDown={(event) => event.stopPropagation()}>
        <div className="modal-header">
          <h2>Indexing finished</h2>
          <button className="icon-button" onClick={close} title="Close">{'\u00D7'}</button>
        </div>

        <div className="index-report-summary">
          <div className="index-report-stat">
            <span className="index-report-value">{report.saved.toLocaleString()}</span>
            <span className="index-report-label">saved</span>
          </div>
          <div className="index-report-stat">
            <span className="index-report-value">{report.total.toLocaleString()}</span>
            <span className="index-report-label">queued</span>
          </div>
          <div className="index-report-stat">
            <span className="index-report-value">{report.failures.length.toLocaleString()}</span>
            <span className="index-report-label">not read</span>
          </div>
          <div className="index-report-stat">
            <span className="index-report-value">{duration}</span>
            <span className="index-report-label">elapsed</span>
          </div>
        </div>

        <p className="muted">
          {report.service} — the saved conversations are searchable right now, including
          chats that are closed.
        </p>

        {report.failures.length > 0 && (
          <>
            <h3 className="index-report-heading">Could not read</h3>
            <p className="muted settings-hint">
              Open any of them in the app once and it will be added to the index
              automatically.
            </p>
            <div className="index-report-list">
              {report.failures.map((failure, index) => (
                <button
                  key={`${failure.url}:${index}`}
                  className="index-report-row"
                  onClick={() => void openFailure(failure.url)}
                  title={failure.url}
                >
                  <span className="index-report-title">{failure.title || failure.url}</span>
                  <span className="index-report-reason">{failure.reason}</span>
                </button>
              ))}
            </div>
          </>
        )}

        {report.failures.length === 0 && (
          <p className="index-report-ok">Every conversation in the queue was saved.</p>
        )}

        <div className="modal-actions">
          <button className="secondary-button" onClick={() => {
            close();
            useAppStore.getState().setIndexConfirmOpen(true);
          }}>
            Index more
          </button>
          <button className="primary-button" onClick={close}>Done</button>
        </div>
      </div>
    </div>
  );
}
