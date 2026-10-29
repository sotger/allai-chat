import { formatDuration } from '@shared/history';
import { useAppStore } from '../store';

export function IndexReportDialog() {
  const report = useAppStore((state) => state.historyReport);
  const setHistoryReport = useAppStore((state) => state.setHistoryReport);
  const setActiveTab = useAppStore((state) => state.setActiveTab);

  if (!report) return null;

  const close = (): void => setHistoryReport(null);
  const duration = formatDuration(report.finishedAt - report.startedAt);
  const remaining = report.remaining ?? 0;

  const openFailure = async (url: string, tabId: string): Promise<void> => {
    close();
    await setActiveTab(tabId);
    await window.allai.openHistoryEntry(tabId, url);
  };

  return (
    <div className="modal-backdrop" onMouseDown={close}>
      <div className="modal index-report-modal" onMouseDown={(event) => event.stopPropagation()}>
        <div className="modal-header">
          <h2>{report.stopped ? 'Indexing stopped' : 'Indexing finished'}</h2>
          <button className="icon-button" onClick={close} title="Close">{'\u00D7'}</button>
        </div>

        <div className="index-report-summary">
          <div className="index-report-stat">
            <span className="index-report-value">{report.saved.toLocaleString()}</span>
            <span className="index-report-label">saved</span>
          </div>
          <div className="index-report-stat">
            <span className="index-report-value">{report.total.toLocaleString()}</span>
            <span className="index-report-label">attempted</span>
          </div>
          <div className="index-report-stat">
            <span className="index-report-value">{report.failures.length.toLocaleString()}</span>
            <span className="index-report-label">not read</span>
          </div>
          <div className="index-report-stat">
            <span className="index-report-value">{remaining.toLocaleString()}</span>
            <span className="index-report-label">left in queue</span>
          </div>
          <div className="index-report-stat">
            <span className="index-report-value">{duration}</span>
            <span className="index-report-label">elapsed</span>
          </div>
        </div>

        <p className="muted">
          {report.services && report.services.length > 1
            ? `${report.services.length} services — the saved conversations are searchable right now, including chats that are closed.`
            : `${report.service} — the saved conversations are searchable right now, including chats that are closed.`}
        </p>

        {report.failures.length > 0 && (
          <>
            <h3 className="index-report-heading">Could not read</h3>
            <p className="muted settings-hint">
              They stay in the queue: open one or run indexing again to retry it.
            </p>
            <div className="index-report-list">
              {(report.services ?? [{ tabId: report.tabId, service: report.service, total: report.total, saved: report.saved, failures: report.failures }])
                .filter((group) => group.failures.length > 0)
                .map((group) => (
                  <div key={group.tabId} className="index-report-group">
                    {report.services && report.services.length > 1 && (
                      <div className="index-report-service">{group.service}</div>
                    )}
                    {group.failures.map((failure, index) => (
                      <button
                        key={`${failure.url}:${index}`}
                        className="index-report-row"
                        onClick={() => void openFailure(failure.url, group.tabId)}
                        title={failure.url}
                      >
                        <span className="index-report-title">{failure.title || failure.url}</span>
                        <span className="index-report-reason">{failure.reason}</span>
                      </button>
                    ))}
                  </div>
                ))}
            </div>
          </>
        )}

        {report.stopped ? (
          <p className="muted">
            Stopped before the queue was empty.
            {remaining > 0
              ? ` ${remaining.toLocaleString()} conversation${remaining === 1 ? '' : 's'} still waiting.`
              : ''}
          </p>
        ) : remaining > 0 ? (
          <p className="muted">
            {remaining.toLocaleString()} conversation{remaining === 1 ? '' : 's'} still
            in the queue. Run indexing again, or open one of them to add it.
          </p>
        ) : report.failures.length === 0 ? (
          <p className="index-report-ok">Every conversation in the queue is indexed.</p>
        ) : null}

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
