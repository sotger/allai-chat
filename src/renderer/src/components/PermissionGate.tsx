import { useEffect } from 'react';
import type { SafariControlAccess, SafariCookieAccess } from '@shared/ipc';

import { useAppStore } from '../store';

type FdaState = SafariCookieAccess | 'unknown';

/**
 * Slim strip under the top bar while Full Disk Access is missing. That grant is
 * the only thing the browser handoff needs, so this strip never appears for the
 * optional Safari control.
 */
export function PermissionAlarm() {
  const status = useAppStore((s) => s.permissionStatus);
  const setDialogOpen = useAppStore((s) => s.setPermissionDialogOpen);

  if (status?.safariCookies !== 'denied') return null;

  return (
    <div className="permission-alarm" role="status">
      <span className="permission-alarm-dot" aria-hidden="true" />
      <span className="permission-alarm-text">
        Browser sign-in is off — macOS has not given ALLAI-CHAT Full Disk Access.
      </span>
      <button className="permission-alarm-action" onClick={() => setDialogOpen(true)}>
        Fix…
      </button>
    </div>
  );
}

function DiskIllustration() {
  return (
    <div className="permission-disk" aria-hidden="true">
      <svg viewBox="0 0 150 112" width="160" height="120">
        <rect className="disk-case" x="10" y="12" width="130" height="84" rx="20" />
        <g className="disk-platter">
          <circle className="disk-plate" cx="75" cy="52" r="27" />
          <circle className="disk-hub" cx="75" cy="52" r="6" />
          <path className="disk-track" d="M75 25 A27 27 0 0 1 98 38" />
          <path className="disk-track" d="M52 66 A27 27 0 0 1 52 38" />
          <path className="disk-track" d="M98 66 A27 27 0 0 1 98 38" />
        </g>
        <rect className="disk-slot" x="38" y="76" width="74" height="6" rx="3" />
      </svg>
    </div>
  );
}

type PillState = 'ok' | 'warn' | 'idle' | 'optional';

const PILL_TONE = { ok: 'good', warn: 'bad', idle: 'idle', optional: 'idle' } as const;

function StatusPill({ state }: { state: PillState }) {
  const label =
    state === 'ok' ? 'Allowed'
      : state === 'warn' ? 'Missing'
        : state === 'optional' ? 'Optional'
          : 'Not checked';
  return <span className={`permission-pill ${PILL_TONE[state]}`}>{label}</span>;
}

function fdaHint(state: FdaState): string {
  switch (state) {
    case 'denied':
      return 'macOS blocked the read. Turn ALLAI-CHAT on under Privacy & Security → Full Disk Access, then press Check again.';
    case 'unreadable':
      return 'Safari’s cookie store could not be read. Sign in once in Safari to rewrite it, then press Check again.';
    case 'missing':
      return 'Safari has not created a cookie store on this Mac yet, so the grant cannot be checked. Open Safari once, then press Check again.';
    case 'ok':
      return 'Lets the app read the session Safari created. Required.';
    default:
      return 'Lets the app read the session Safari created. Required.';
  }
}

function controlHint(state: SafariControlAccess): string {
  switch (state) {
    case 'ok':
      return 'The app may close the Safari tab it opened for you.';
    case 'no-js':
      return 'macOS allows control, Safari blocks scripting. Safari → Develop → Allow JavaScript from Apple Events, then press Try again.';
    case 'denied':
      return 'macOS refused. Sign-in still works; the Safari tab is simply left open.';
    case 'unsupported':
      return 'Not available on this system.';
    default:
      return 'Optional. Lets the app close the Safari tab once the session arrives, and press the sign-in button for you.';
  }
}

/**
 * macOS offers no API to request these permissions: the app can only explain
 * them and send the user to the right System Settings pane. Full Disk Access is
 * required; Apple Events are optional and are only ever probed on an explicit
 * click, because the probe itself is what makes macOS show its prompt.
 */
export function PermissionDialog() {
  const open = useAppStore((s) => s.permissionDialogOpen);
  const setOpen = useAppStore((s) => s.setPermissionDialogOpen);
  const hidden = useAppStore((s) => s.preferences.fullDiskAccessNoticeHidden);
  const updatePreferences = useAppStore((s) => s.updatePreferences);
  const setNotice = useAppStore((s) => s.setNotice);
  const status = useAppStore((s) => s.permissionStatus);
  const setStatus = useAppStore((s) => s.setPermissionStatus);

  const fda: FdaState = status?.safariCookies ?? 'unknown';
  const control: SafariControlAccess = status?.safariControl ?? 'unknown';
  const allOk = fda === 'ok';

  // Poll while the dialog is open: the user is in System Settings and the state
  // should update without a restart.
  useEffect(() => {
    if (!open || allOk) return;
    const timer = setInterval(() => {
      void window.allai.getPermissionStatus()
        .then((next) => useAppStore.getState().setPermissionStatus(next))
        .catch(() => undefined);
    }, 1200);
    return () => clearInterval(timer);
  }, [open, allOk]);

  // Everything in place: say so, then get out of the way.
  useEffect(() => {
    if (!open || !allOk) return;
    const timer = setTimeout(() => {
      setOpen(false);
      setNotice('Full Disk Access is granted — browser sign-in can take the session from Safari now.');
    }, 1800);
    return () => clearTimeout(timer);
  }, [open, allOk, setOpen, setNotice]);

  if (!open) return null;

  /** The only place that sends the Apple Event, and only because the user asked. */
  const requestControl = async (): Promise<void> => {
    const next = await window.allai.requestSafariControl().catch(() => undefined);
    if (!next) return;
    setStatus(next);
    if (next.safariControl === 'ok') {
      setNotice('Safari control is on — ALLAI-CHAT can close the Safari tab for you.');
    } else if (next.safariControl === 'no-js') {
      // Automation is already granted; what is missing is Safari's own switch.
      setNotice('macOS allowed control. Safari still blocks scripting: Develop → Allow JavaScript from Apple Events.');
    } else if (next.safariControl === 'denied') {
      setNotice('macOS did not allow controlling Safari. Sign-in works without it.');
    } else {
      setNotice('macOS did not answer the Automation request — sign-in works without it.');
    }
  };

  const recheck = async (): Promise<void> => {
    const next = await window.allai.getPermissionStatus().catch(() => undefined);
    if (next) setStatus(next);
  };

  const openSafari = async (): Promise<void> => {
    await window.allai.openSafari().catch(() => undefined);
    setNotice('Safari opened. Sign in once there, then press Check again.');
  };

  const fdaPill: PillState = fda === 'ok' ? 'ok' : fda === 'denied' ? 'warn' : 'idle';

  return (
    <div className="modal-backdrop" onMouseDown={() => setOpen(false)}>
      <div className="modal permission-modal" onMouseDown={(event) => event.stopPropagation()}>
        {allOk ? (
          <div className="permission-granted">
            <div className="permission-granted-mark" aria-hidden="true">✓</div>
            <h2>All set</h2>
            <p className="permission-lead">
              ALLAI-CHAT can read the session Safari creates. Closing this…
            </p>
          </div>
        ) : (
          <>
            <DiskIllustration />
            <h2>Full Disk Access makes sign-in hands-free</h2>
            <p className="permission-lead">
              Passkey and Google sign-in cannot finish inside this app. ALLAI-CHAT opens the
              service in Safari and takes the session back. Only Full Disk Access is required
              for that.
            </p>

            <div className="permission-list">
              <div className="permission-row">
                <div className="permission-row-main">
                  <div className="permission-row-title">Full Disk Access</div>
                  <div className="permission-row-hint">{fdaHint(fda)}</div>
                </div>
                <StatusPill state={fdaPill} />
                {fda === 'denied' && (
                  <button className="secondary-button" onClick={() => void window.allai.openFullDiskAccessSettings()}>
                    Open Settings
                  </button>
                )}
                {(fda === 'missing' || fda === 'unreadable') && (
                  <button className="secondary-button" onClick={() => void openSafari()}>
                    Open Safari
                  </button>
                )}
              </div>

              <div className="permission-row">
                <div className="permission-row-main">
                  <div className="permission-row-title">Control Safari</div>
                  <div className="permission-row-hint">{controlHint(control)}</div>
                </div>
                <StatusPill state={control === 'ok' ? 'ok' : 'optional'} />
                {control !== 'ok' && (
                  <button className="secondary-button" onClick={() => void requestControl()}>
                    {control === 'unknown' ? 'Ask macOS…' : 'Try again'}
                  </button>
                )}
              </div>
            </div>

            <p className="permission-fineprint">
              Nothing else needs these: the history index, search and sync work without them.
              Permissions are tied to the app signature, so an update may ask again.
            </p>
            <label className="permission-checkbox">
              <input
                type="checkbox"
                checked={hidden}
                onChange={(event) => void updatePreferences({ fullDiskAccessNoticeHidden: event.target.checked })}
              />
              Don&apos;t remind me again
            </label>
            <div className="modal-actions">
              <button className="secondary-button" onClick={() => void recheck()}>
                Check again
              </button>
              <button className="secondary-button" onClick={() => setOpen(false)}>
                Later
              </button>
              <button className="primary-button" onClick={() => void window.allai.openFullDiskAccessSettings()}>
                Open System Settings
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
