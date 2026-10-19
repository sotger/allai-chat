import type { DownloadRecord } from '@shared/ipc';
import { useAppStore } from '../store';

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function statusLine(record: DownloadRecord): string {
  switch (record.state) {
    case 'completed':
      return formatBytes(record.receivedBytes);
    case 'cancelled':
      return 'Cancelled';
    case 'interrupted':
      return 'Interrupted';
    default:
      return record.totalBytes > 0
        ? `${formatBytes(record.receivedBytes)} of ${formatBytes(record.totalBytes)}`
        : formatBytes(record.receivedBytes);
  }
}

function DownloadRow({ record }: { record: DownloadRecord }) {
  const active = record.state === 'progressing';
  const progress = active && record.totalBytes > 0
    ? Math.min(100, (record.receivedBytes / record.totalBytes) * 100)
    : null;

  return (
    <div className="download-row">
      <div className="download-body">
        <div className="download-name" title={record.savePath || record.filename}>{record.filename}</div>
        <div className="download-meta">
          <span>{statusLine(record)}</span>
          {active && <span className="download-percent">{progress === null ? '…' : `${Math.round(progress)}%`}</span>}
        </div>
        {active && (
          <div className={`download-progress ${progress === null ? 'indeterminate' : ''}`}>
            <span style={progress === null ? undefined : { width: `${progress}%` }} />
          </div>
        )}
        {record.state === 'completed' && (
          <div className="download-progress done"><span /></div>
        )}
      </div>
      <div className="download-actions">
        {record.state === 'progressing' && (
          <button className="mini-button" onClick={() => void window.allai.cancelDownload(record.id)} title="Cancel download">
            Cancel
          </button>
        )}
        {record.state === 'completed' && (
          <>
            <button className="mini-button" onClick={() => void window.allai.openDownload(record.id)} title="Open file">
              Open
            </button>
            <button className="mini-button" onClick={() => void window.allai.showDownload(record.id)} title="Show in folder">
              Folder
            </button>
          </>
        )}
        {(record.state === 'cancelled' || record.state === 'interrupted') && (
          <button className="mini-button" onClick={() => void window.allai.showDownload(record.id)} title="Show in folder">
            Folder
          </button>
        )}
      </div>
    </div>
  );
}

export function DownloadsPanel() {
  const open = useAppStore((s) => s.downloadsOpen);
  const downloads = useAppStore((s) => s.downloads);
  const setDownloadsOpen = useAppStore((s) => s.setDownloadsOpen);

  if (!open) return null;

  return (
    <>
      <div className="downloads-backdrop" onMouseDown={() => setDownloadsOpen(false)} />
      <div className="downloads-panel">
        <div className="downloads-header">
          <strong>Downloads</strong>
          <button className="icon-button" onClick={() => setDownloadsOpen(false)} title="Close">{'\u00D7'}</button>
        </div>
        {downloads.length === 0 ? (
          <p className="downloads-empty">No downloads yet.</p>
        ) : (
          <div className="downloads-list">
            {downloads.map((record) => <DownloadRow key={record.id} record={record} />)}
          </div>
        )}
      </div>
    </>
  );
}
