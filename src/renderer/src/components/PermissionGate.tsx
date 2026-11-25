import { useEffect } from 'react';

import { useAppStore } from '../store';

/**
 * Slim strip under the top bar while a permission the browser handoff needs is
 * missing. Full Disk Access is required; Safari control only makes the flow
 * hands-free.
 */
export function PermissionAlarm() {
  const status = useAppStore((s) => s.permissionStatus);
  const setDialogOpen = useAppStore((s) => s.setPermissionDialogOpen);
  const fdaMissing = status?.safariCookies === 'denied';
  const controlMissing = status?.safariControl === 'denied';

  if (!fdaMissing && !controlMissing) return null;

  return (
    <div className="permission-alarm" role="status">
      <span className="permission-alarm-dot" aria-hidden="true" />
      <span className="permission-alarm-text">
        {fdaMissing
          ? 'Browser sign-in is off — macOS has not given ALLAI-CHAT Full Disk Access.'
          : 'Browser sign-in works, but ALLAI-CHAT is not allowed to control Safari, so the login is not completed for you.'}
      </span>
      <button className="permission-alarm-action" onClick={() => setDialogOpen(true)}>
        Fix…
      </button>
    </div>
  );
}

function DiskAnimation() {
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

const DOT = { ok: 'good', warn: 'bad', idle: 'idle' } as const;

function StatusPill({ state }: { state: 'ok' | 'warn' | 'idle' }) {
  const label = state === 'ok' ? 'Allowed' : state === 'warn' ? 'Missing' : 'Not checked';
  return <span className={`permission-pill ${DOT[state]}`}>{label}</span>;
}

/**
 * macOS offers no API to request these permissions: the app can only explain
 * them and send the user to the right System Settings pane. This dialog is the
 * one place that shows every check, so it is opened at startup.
 */
export function PermissionDialog() {
  const open = useAppStore((s) => s.permissionDialogOpen);
  const setOpen = useAppStore((s) => s.setPermissionDialogOpen);
  const hidden = useAppStore((s) => s.preferences.fullDiskAccessNoticeHidden);
  const updatePreferences = useAppStore((s) => s.updatePreferences);
  const setNotice = useAppStore((s) => s.setNotice);
  const status = useAppStore((s) => s.permissionStatus);
  const setStatus = useAppStore((s) => s.setPermissionStatus);

  const fda = status?.safariCookies ?? 'unknown';
  const control = status?.safariControl ?? 'unknown';
  const allOk = fda === 'ok' && control === 'ok';

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
      setNotice('Permissions are set — browser sign-in is fully automatic now.');
    }, 1800);
    return () => clearTimeout(timer);
  }, [open, allOk, setOpen, setNotice]);

  if (!open) return null;

  const requestControl = async (): Promise<void> => {
    const next = await window.allai.requestSafariControl().catch(() => undefined);
    if (!next) return;
    setStatus(next);
    if (next.safariControl === 'ok') {
      setNotice('Safari control is on — ALLAI-CHAT can press the login button for you.');
    } else if (next.safariControl === 'no-js') {
      // Automation is already granted; what is missing is Safari's own switch.
      setNotice('macOS allowed control. Safari still blocks scripting: Develop → Allow JavaScript from Apple Events.');
    } else {
      setNotice('macOS did not allow controlling Safari. Enable ALLAI-CHAT under Privacy & Security → Automation.');
    }
  };

  const recheck = async (): Promise<void> => {
    const next = await window.allai.getPermissionStatus().catch(() => undefined);
    if (next) setStatus(next);
    await requestControl();
  };

  return (
    <div className="modal-backdrop" onMouseDown={() => setOpen(false)}>
      <div className="modal permission-modal" onMouseDown={(event) => event.stopPropagation()}>
        {allOk ? (
          <div className="permission-granted">
            <div className="permission-granted-mark" aria-hidden="true">✓</div>
            <h2>All set</h2>
            <p className="permission-lead">
              Browser sign-in can now finish in Safari and come back on its own. Closing this…
            </p>
          </div>
        ) : (
          <>
            <DiskAnimation />
            <h2>Two permissions make sign-in hands-free</h2>
            <p className="permission-lead">
              Passkey and Google sign-in cannot finish inside this app. ALLAI-CHAT opens the
              service in Safari, presses the login button for you, and takes the session back.
            </p>

            <div className="permission-list">
              <div className="permission-row">
                <div className="permission-row-main">
                  <div className="permission-row-title">Full Disk Access</div>
                  <div className="permission-row-hint">
                    Lets the app read the session Safari created. Required.
                  </div>
                </div>
                <StatusPill state={fda === 'ok' ? 'ok' : 'warn'} />
                {fda !== 'ok' && (
                  <button className="secondary-button" onClick={() => void window.allai.openFullDiskAccessSettings()}>
                    Open Settings
                  </button>
                )}
              </div>

              <div className="permission-row">
                <div className="permission-row-main">
                  <div className="permission-row-title">Control Safari</div>
                  <div className="permission-row-hint">
                    {control === 'no-js'
                      ? 'macOS already allows control. Safari blocks scripting: open Safari → Develop → Allow JavaScript from Apple Events, then press Try again.'
                      : control === 'denied'
                        ? 'macOS refused. Enable ALLAI-CHAT under Privacy & Security → Automation, then press Try again.'
                        : 'Lets the app press “Sign in” / “Continue with Google” in the browser. Optional.'}
                  </div>
                </div>
                <StatusPill state={control === 'ok' ? 'ok' : control === 'unknown' ? 'idle' : 'warn'} />
                {control === 'no-js' && (
                  <button className="secondary-button" onClick={() => void window.allai.openSafari()}>
                    Open Safari
                  </button>
                )}
                {control !== 'ok' && (
                  <button className="secondary-button" onClick={() => void requestControl()}>
                    {control === 'unknown' ? 'Allow…' : 'Try again'}
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
              {fda !== 'ok' && (
                <button className="primary-button" onClick={() => void window.allai.openFullDiskAccessSettings()}>
                  Open System Settings
                </button>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
