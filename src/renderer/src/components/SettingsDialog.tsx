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
