import { UI_FONT_SIZES } from '@shared/preferences';
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
            <button className="secondary-button" onClick={() => void openGoogleSignIn()}>
              Sign in to Google once…
            </button>
            <button
              className="secondary-button"
              onClick={() => void syncGoogleSignIn()}
              disabled={!preferences.reuseGoogleSignIn}
            >
              Apply to services
            </button>
          </div>
          <p className="muted settings-hint">
            Google does not allow completing another service's OAuth flow in your system
            browser: the callback has to return to the service itself. This keeps the
            sign-in inside the app and asks for the password only once.
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
