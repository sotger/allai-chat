import { useEffect, useRef, useState } from 'react';

import { useAppStore } from '../store';

interface CookiesImportDialogProps {
  tabId?: string;
  onClose: () => void;
}

/**
 * Passkeys ("Sign in with iPhone", security keys) cannot complete inside
 * Electron, so services that only offer them have to be signed in elsewhere.
 * Two ways out are offered here:
 *
 * - sign in in Safari and let the app pick the session up from Safari's cookie
 *   store (macOS only, needs Full Disk Access);
 * - paste or load a cookie export from any browser.
 */
export function CookiesImportDialog({ tabId, onClose }: CookiesImportDialogProps) {
  const tabs = useAppStore((state) => state.tabs);
  const setNotice = useAppStore((state) => state.setNotice);

  const [text, setText] = useState('');
  const [fileName, setFileName] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const [isMac, setIsMac] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    void window.allai.getAppInfo()
      .then((info) => setIsMac(info.platform === 'darwin'))
      .catch(() => setIsMac(false));
  }, []);

  const tab = tabs.find((item) => item.id === tabId);
  const host = (() => {
    try {
      return tab?.url ? new URL(tab.url).hostname : '';
    } catch {
      return '';
    }
  })();

  useEffect(() => {
    if (!tabId) return;
    setText('');
    setFileName(undefined);
    setBusy(false);
    setWaiting(false);
    inputRef.current?.focus();
  }, [tabId]);

  useEffect(() => {
    if (!tab) return undefined;
    return window.allai.onBrowserSignInResult((result) => {
      if (result.tabId !== tab.id) return;
      // The toasts live in App.tsx; the dialog only closes itself once a
      // session was taken over.
      setWaiting(false);
      if (result.state === 'imported') onClose();
    });
  }, [tab, onClose, setNotice]);

  if (!tabId || !tab) return null;

  const chooseFile = async (): Promise<void> => {
    const pick = await window.allai.chooseCookieFile();
    if (pick.canceled) return;
    setFileName(pick.name);
    if (pick.error === 'too-large') {
      setNotice('That file is larger than 1 MB — export only the cookies for this service.');
      return;
    }
    if (pick.error || pick.text === undefined) {
      setNotice('Could not read that file.');
      return;
    }
    setText(pick.text);
  };

  const takeFromSafari = async (): Promise<void> => {
    setBusy(true);
    try {
      const result = await window.allai.importSafariNow(tab.id);
      if (result.imported > 0 && result.hasSession) {
        setNotice(
          `Imported ${result.imported} cookie${result.imported === 1 ? '' : 's'} from Safari into ${tab.label}.`
        );
        onClose();
        return;
      }
      if (result.imported > 0 && !result.hasSession) {
        setNotice(`Safari has cookies for ${result.host || host} but no signed-in session yet — log in there first.`);
        return;
      }
      setNotice(
        result.error === 'denied'
          ? 'macOS blocked reading Safari cookies. Grant ALLAI-CHAT Full Disk Access in System Settings → Privacy & Security, then try again.'
          : result.error === 'none'
            ? `Safari has no session for ${result.host || host} yet — sign in there first.`
            : 'Could not read Safari cookies.'
      );
    } finally {
      setBusy(false);
    }
  };

  const startSafari = async (): Promise<void> => {
    const result = await window.allai.startBrowserSignIn(tab.id);
    if (!result.ok) {
      setNotice(
        result.reason === 'unsupported'
          ? 'The Safari handoff is macOS-only. Use the cookie export below.'
          : 'Could not start the Safari handoff for this tab.'
      );
      return;
    }
    setWaiting(true);
  };

  const cancelWaiting = async (): Promise<void> => {
    setWaiting(false);
    await window.allai.cancelBrowserSignIn().catch(() => undefined);
  };

  const submit = async (): Promise<void> => {
    setBusy(true);
    try {
      const result = await window.allai.importCookies(tab.id, text);
      if (result.error === 'too-large') {
        setNotice('The pasted text is larger than 1 MB — export only the cookies for this service.');
        return;
      }
      if (result.error === 'empty') {
        setNotice('No cookies found in that text.');
        return;
      }
      if (result.matched === 0) {
        setNotice(`No cookies for ${result.host || host} in that text (${result.total} were for other sites).`);
        return;
      }
      if (result.imported === 0) {
        setNotice(`None of the ${result.matched} cookies for ${result.host} could be imported.`);
        return;
      }
      setNotice(
        `Imported ${result.imported} cookie${result.imported === 1 ? '' : 's'} into ${tab.label} and reloaded it.`
      );
      onClose();
    } catch (err) {
      setNotice(`Cookie import failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal cookies-import-modal" onMouseDown={(event) => event.stopPropagation()}>
        <div className="modal-header">
          <h2>Sign in with cookies</h2>
          <button className="icon-button" onClick={onClose} title="Close">{'\u00D7'}</button>
        </div>

        <p className="index-confirm-text">
          Passkeys — including Apple&apos;s <strong>Sign in with iPhone</strong> — cannot
          finish inside Electron. Sign in to this service in a browser, and let the app
          take that session over for <strong>{tab.label}</strong>.
        </p>

        <p className="muted settings-hint">
          Target host: <strong>{host || 'unknown'}</strong>. Cookies for other sites are
          ignored. Everything stays on this Mac — nothing is uploaded.
        </p>

        {isMac && (
          <div className="cookies-browser-row">
            {waiting ? (
            <>
                <span className="cookies-waiting">Waiting for Safari… sign in there, this window updates by itself.</span>
                <button className="secondary-button" onClick={() => void cancelWaiting()}>Stop waiting</button>
              </>
            ) : (
              <>
                <button className="primary-button" onClick={() => void startSafari()} disabled={busy}>
                  Open in Safari and wait
                </button>
                <button className="secondary-button" onClick={() => void takeFromSafari()} disabled={busy}>
                  Take the session from Safari now
                </button>
              </>
            )}
          </div>
        )}

        {isMac && (
          <p className="muted settings-hint">
            The Safari route needs Full Disk Access for the app (System Settings → Privacy
            &amp; Security → Full Disk Access). Without it, use the export below.
          </p>
        )}

        <textarea
          ref={inputRef}
          className="cookies-textarea"
          spellCheck={false}
          value={text}
          onChange={(event) => setText(event.target.value)}
          placeholder={`# Netscape cookies.txt, or a Cookie: header\n.chatgpt.com\tTRUE\t/\tTRUE\t1798765432\t__Secure-authjs.session-token\teyJhbGci…`}
        />

        <div className="cookies-file-row">
          <button className="secondary-button" onClick={() => void chooseFile()} disabled={busy}>
            Choose file…
          </button>
          <span className="muted settings-hint">
            {fileName ? fileName : 'Or paste the export above.'}
          </span>
        </div>

        <div className="modal-actions">
          <button className="secondary-button" onClick={onClose} disabled={busy}>Cancel</button>
          <button
            className="primary-button"
            onClick={() => void submit()}
            disabled={busy || text.trim().length === 0}
          >
            {busy ? 'Importing…' : 'Import and reload'}
          </button>
        </div>
      </div>
    </div>
  );
}
