import { useEffect, useState } from 'react';
import { UI_FONT_SIZES } from '@shared/preferences';
import type { GoogleVaultState } from '@shared/ipc';
import type { DetectedSyncFolder } from '@shared/sync';
import type { ThemePreference } from '@shared/types';
import { useAppStore } from '../store';

const THEMES: Array<{ value: ThemePreference; label: string }> = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' }
];

const FONT_LABELS: Record<number, string> = {
  13: 'Default',
  14: 'Large',
  15: 'Larger',
  16: 'Largest'
};

export function SettingsDialog() {
  const open = useAppStore((s) => s.settingsOpen);
  const preferences = useAppStore((s) => s.preferences);
  const setSettingsOpen = useAppStore((s) => s.setSettingsOpen);
  const updatePreferences = useAppStore((s) => s.updatePreferences);
  const chooseDownloadDirectory = useAppStore((s) => s.chooseDownloadDirectory);
  const openGoogleSignIn = useAppStore((s) => s.openGoogleSignIn);
  const syncGoogleSignIn = useAppStore((s) => s.syncGoogleSignIn);
  const historyStats = useAppStore((s) => s.historyStats);
  const historyProgress = useAppStore((s) => s.historyProgress);
  const setIndexConfirmOpen = useAppStore((s) => s.setIndexConfirmOpen);
  const stopHistoryIndex = useAppStore((s) => s.stopHistoryIndex);
  const clearHistory = useAppStore((s) => s.clearHistory);
  const syncStatus = useAppStore((s) => s.syncStatus);
  const chooseSyncFolder = useAppStore((s) => s.chooseSyncFolder);
  const openSyncFolder = useAppStore((s) => s.openSyncFolder);
  const syncHistoryNow = useAppStore((s) => s.syncHistoryNow);
  const exportHistory = useAppStore((s) => s.exportHistory);
  const importHistory = useAppStore((s) => s.importHistory);
  const isBusy = useAppStore((s) => s.isBusy);

  const [syncFolders, setSyncFolders] = useState<DetectedSyncFolder[]>([]);
  const [googleVault, setGoogleVault] = useState<GoogleVaultState>();

  useEffect(() => {
    if (!open) return;
    void window.allai.getSyncFolders().then(setSyncFolders).catch(() => setSyncFolders([]));
  }, [open]);

  const refreshGoogleVault = (): void => {
    void window.allai.getGoogleVaultState().then(setGoogleVault).catch(() => setGoogleVault(undefined));
  };

  useEffect(() => {
    if (open) refreshGoogleVault();
  }, [open]);

  // The vault is filled by a Safari handoff or when the Google window closes.
  useEffect(() => window.allai.onGoogleSignInDone(() => refreshGoogleVault()), []);

  const applyGoogleToServices = async (): Promise<void> => {
    await syncGoogleSignIn().catch(() => undefined);
    refreshGoogleVault();
  };

  if (!open) return null;

  const close = (): void => setSettingsOpen(false);

  return (
    <div className="modal-backdrop" onMouseDown={close}>
      <div className="modal settings-modal" onMouseDown={(event) => event.stopPropagation()}>
        <div className="modal-header">
          <h2>Settings</h2>
          <button className="icon-button" onClick={close} title="Close">{'\u00D7'}</button>
        </div>

        <section className="settings-section">
          <h3>Appearance</h3>
          <p className="muted">The app and the websites follow this theme.</p>
          <div className="segmented" role="group" aria-label="Theme">
            {THEMES.map((theme) => (
              <button
                key={theme.value}
                className={`segment ${preferences.theme === theme.value ? 'active' : ''}`}
                onClick={() => void updatePreferences({ theme: theme.value })}
              >
                {theme.label}
              </button>
            ))}
          </div>
        </section>

        <section className="settings-section">
          <h3>Interface size</h3>
          <p className="muted">
            Scales the sidebar, toolbar and dialogs. Websites keep their own zoom level.
          </p>
          <div className="segmented" role="group" aria-label="Interface font size">
            {UI_FONT_SIZES.map((size) => (
              <button
                key={size}
                className={`segment ${preferences.uiFontSize === size ? 'active' : ''}`}
                onClick={() => void updatePreferences({ uiFontSize: size })}
              >
                {FONT_LABELS[size]}
                <span className="segment-value">{size}</span>
              </button>
            ))}
          </div>
        </section>

        <section className="settings-section">
          <h3>History search</h3>
          <p className="muted">
            Global search can look inside conversations you have already opened, not only the
            ones that are open right now. Everything stays in a local file in the app's data
            folder and is never uploaded.
          </p>
          <label className="settings-check">
            <input
              type="checkbox"
              checked={preferences.historyIndexEnabled}
              onChange={(event) => void updatePreferences({ historyIndexEnabled: event.target.checked })}
            />
            <span>
              Index conversations locally
              <span className="settings-help">
                Captures the text of each chat after it renders, so a closed conversation is
                still searchable. Turning this off stops capture; use "Clear index" to delete
                what is already stored.
              </span>
            </span>
          </label>
          <label className="settings-check">
            <input
              type="checkbox"
              checked={preferences.historyBackfillEnabled}
              disabled={!preferences.historyIndexEnabled}
              onChange={(event) => void updatePreferences({ historyBackfillEnabled: event.target.checked })}
            />
            <span>
              Fill older chats in the background
              <span className="settings-help">
                Opens a hidden window and reads older conversations one at a time, 3–8 seconds
                apart, and stops on a rate limit or a captcha. Off by default: a burst of
                automated page loads is what makes a service treat an app as a bot.
              </span>
            </span>
          </label>
          <div className="settings-row">
            <button
              className="secondary-button"
              onClick={() => setIndexConfirmOpen(true)}
              disabled={!preferences.historyIndexEnabled || historyProgress.running}
            >
              Index now
            </button>
            <button
              className="secondary-button"
              onClick={() => void stopHistoryIndex()}
              disabled={!historyProgress.running}
            >
              Stop
            </button>
            <button
              className="secondary-button danger-button"
              onClick={() => void clearHistory()}
              disabled={historyStats.entries === 0}
            >
              Clear index
            </button>
          </div>
          <p className="muted settings-hint">
            {historyStats.entries.toLocaleString()} conversations stored
            {historyStats.withText > 0 ? `, ${historyStats.withText.toLocaleString()} with full text` : ''}
            {historyStats.withoutText > 0 ? `, ${historyStats.withoutText.toLocaleString()} still waiting in the queue` : ''}
            {historyStats.characters > 0 ? `, ${Math.max(1, Math.round(historyStats.characters / 1024)).toLocaleString()} KB` : ''}.
          </p>
        </section>

        <section className="settings-section">
          <h3>Sync &amp; backup</h3>
          <p className="muted">
            Write a portable copy of the search index into a folder your cloud client already
            syncs — iCloud Drive, Google Drive, OneDrive, Dropbox, Nextcloud or a network share.
            Each device keeps its own file and merges the others; no account, OAuth or API key is
            involved.
          </p>
          <label className="settings-check">
            <input
              type="checkbox"
              checked={preferences.syncEnabled}
              disabled={!preferences.syncFolder}
              onChange={(event) => void updatePreferences({ syncEnabled: event.target.checked })}
            />
            <span>
              Keep a synced copy in this folder
              <span className="settings-help">
                The app writes allai-history-&lt;device&gt;.json after changes and merges files
                from your other computers. Your cloud app does the upload; nothing is sent by
                ALLAI-CHAT itself.
              </span>
            </span>
          </label>
          <div className="settings-row">
            <input
              className="settings-path"
              value={preferences.syncFolder || 'No folder selected'}
              readOnly
              title={preferences.syncFolder || undefined}
            />
            <button className="secondary-button" onClick={() => void chooseSyncFolder()} disabled={isBusy}>
              {preferences.syncFolder ? 'Change…' : 'Choose…'}
            </button>
          </div>
          {syncFolders.length > 0 && (
            <div className="settings-row sync-suggestions">
              {syncFolders.slice(0, 6).map((folder) => {
                const active = preferences.syncFolder === folder.path;
                return (
                  <button
                    key={folder.path}
                    className={`secondary-button ${active ? 'active' : ''}`}
                    title={folder.path}
                    onClick={() => {
                      if (active) {
                        if (preferences.syncEnabled) void syncHistoryNow();
                        return;
                      }
                      void updatePreferences({ syncFolder: folder.path, syncEnabled: true })
                        .then(() => syncHistoryNow());
                    }}
                  >
                    {active ? '\u2713 ' : ''}
                    {folder.label}
                  </button>
                );
              })}
            </div>
          )}
          <div className="settings-row">
            <button
              className="secondary-button"
              onClick={() => void syncHistoryNow()}
              disabled={!preferences.syncFolder || !preferences.syncEnabled || isBusy}
            >
              Sync now
            </button>
            <button
              className="secondary-button"
              onClick={() => void openSyncFolder()}
              disabled={!preferences.syncFolder}
            >
              Open folder
            </button>
            <button className="secondary-button" onClick={() => void exportHistory()}>
              Export…
            </button>
            <button className="secondary-button" onClick={() => void importHistory()}>
              Import…
            </button>
          </div>
          <p className="muted settings-hint">
            {syncStatus?.lastError
              ? `Last sync failed: ${syncStatus.lastError}`
              : syncStatus?.lastSyncAt
                ? `Last sync ${new Date(syncStatus.lastSyncAt).toLocaleString()}`
                  + `${syncStatus.files > 1 ? `, ${syncStatus.files} devices` : ', this device only'}`
                  + `${syncStatus.summary ? ` — ${syncStatus.summary}` : ''}.`
                : 'Not synced yet. Export… works without a cloud folder.'}
          </p>
          {(syncStatus?.unreadFiles?.length ?? 0) > 0 && (
            <p className="muted settings-hint" title={syncStatus?.unreadFiles?.join('\n')}>
              Not read yet:{' '}
              {syncStatus?.unreadFiles?.slice(0, 4).join(', ')}
              {(syncStatus?.unreadFiles?.length ?? 0) > 4
                ? ` and ${(syncStatus?.unreadFiles?.length ?? 0) - 4} more`
                : ''}
              . The file may still be uploading, not downloaded from the cloud, or damaged;
              the app retries on the next sync.
            </p>
          )}
          <p className="muted settings-hint">
            Conversations are matched to a tab by service, then by label. Give duplicate
            service tabs different names (double-click a tab) to keep them separate.
          </p>
        </section>

        <section className="settings-section">
          <h3>Downloads</h3>
          <p className="muted">Files from any service are saved to this folder.</p>
          <div className="settings-row">
            <input
              className="settings-path"
              value={preferences.downloadDirectory}
              readOnly
              title={preferences.downloadDirectory}
            />
            <button className="secondary-button" onClick={() => void chooseDownloadDirectory()}>
              Choose…
            </button>
          </div>
        </section>

        <section className="settings-section">
          <h3>Google sign-in</h3>
          <label className="settings-check">
            <input
              type="checkbox"
              checked={preferences.reuseGoogleSignIn}
              onChange={(event) => void updatePreferences({ reuseGoogleSignIn: event.target.checked })}
            />
            <span>
              Reuse one Google sign-in across services
              <span className="settings-help">
                Stores your Google session locally and copies its cookies into service tabs
                that are not signed in yet. Each service still keeps its own cookies.
              </span>
            </span>
          </label>
          <div className="settings-row">
            <span className="settings-status">
              {googleVault === undefined
                ? 'Checking…'
                : googleVault.saved
                  ? `Saved on this Mac — ${googleVault.cookies} Google cookies`
                  : 'No Google session saved yet'}
            </span>
          </div>
          <div className="settings-row">
            <button className="secondary-button" onClick={() => void openGoogleSignIn()}>
              Google accounts…
            </button>
            <button
              className="secondary-button"
              onClick={() => void applyGoogleToServices()}
              disabled={!preferences.reuseGoogleSignIn || !googleVault?.saved}
            >
              Apply to services
            </button>
          </div>
          <p className="muted settings-hint">
            This is one Google login, like one browser profile: sign in several accounts with
            <strong> Google accounts…</strong> and Google will offer the chooser to any service
            that asks. A login that used a different account in Safari replaces nothing here —
            it stays in that tab. Each service keeps its own cookies; <strong>Reset login
            info</strong> opts one tab out of the sharing.
          </p>
        </section>

        <p className="modal-hint">
          Tip: you can still add the same service twice and use two different accounts —
          sign in with another Google account in that tab.
        </p>
      </div>
    </div>
  );
}
