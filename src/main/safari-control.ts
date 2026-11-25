import { execFile } from 'node:child_process';

/**
 * Optional Safari control through Apple Events. It lets the app press the
 * service's own "Sign in" / "Continue with Google" button in the browser, so the
 * user does not have to repeat the click there.
 *
 * Two macOS switches are involved and both can be missing:
 *  - Automation ("ALLAI-CHAT wants to control Safari"), granted on the first
 *    Apple Event; it needs NSAppleEventsUsageDescription in Info.plist.
 *  - Safari's Develop → "Allow JavaScript from Apple Events", without which
 *    `do JavaScript` is refused.
 *
 * Everything here is best effort: a failure just means the user clicks in
 * Safari themselves, exactly like before.
 */

export type SafariControlResult = 'ok' | 'denied' | 'no-js' | 'no-page' | 'unsupported';

/** Startup state of the optional Safari control, before any click is tried. */
export type SafariControlStatus = 'ok' | 'denied' | 'no-js' | 'unknown' | 'unsupported';

function osascript(script: string): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      '/usr/bin/osascript',
      ['-e', script],
      { timeout: 20_000 },
      (error, stdout, stderr) => {
        resolve({
          ok: !error,
          stdout: String(stdout).trim(),
          stderr: String(stderr).trim()
        });
      }
    );
  });
}

/** The page-side click: open the login modal if needed, then press Google. */
const CLICK_SCRIPT = `
(() => {
  const pick = (re) => Array.from(document.querySelectorAll('button,a,[role="button"]'))
    .find((el) => re.test((el.innerText || el.getAttribute('aria-label') || '').trim()));
  const provider = /continue with google|sign in with google|continue with apple|sign in with apple/i;
  const entry = /^(sign in|log in|войти)( with .*)?$/i;

  const direct = pick(provider);
  if (direct) {
    (direct.closest('button,a,[role="button"]') || direct).click();
    return 'clicked-provider';
  }
  const opener = pick(entry);
  if (!opener) return 'no-button';
  (opener.closest('button,a,[role="button"]') || opener).click();
  setTimeout(() => {
    const later = pick(provider);
    if (later) (later.closest('button,a,[role="button"]') || later).click();
  }, 900);
  return 'clicked-entry';
})()
`;

/** Presses the sign-in button of the service page that is open in Safari. */
export async function clickSafariSignIn(host: string): Promise<SafariControlResult> {
  if (process.platform !== 'darwin') return 'unsupported';
  const escaped = host.replace(/["\\]/g, '');
  const script = `
set targetURL to ""
tell application "Safari"
  repeat 20 times
    try
      set targetURL to URL of first document whose URL contains "${escaped}"
      exit repeat
    end try
    delay 0.5
  end repeat
  if targetURL is "" then return "no-page"
  do JavaScript ${JSON.stringify(CLICK_SCRIPT)} in first document whose URL contains "${escaped}"
end tell
`;

  const result = await osascript(script);
  const out = `${result.stdout}\n${result.stderr}`;
  if (!result.ok) {
    // -1743: the user (or TCC) refused Apple Events for this app.
    if (/-1743|not authori[sz]ed|Not authori[sz]ed/i.test(out)) return 'denied';
    if (/do JavaScript|JavaScript from Apple Events|not allowed/i.test(out)) return 'no-js';
    return 'no-page';
  }
  if (result.stdout === 'no-page') return 'no-page';
  return 'ok';
}

/**
 * Probes the Automation grant and Safari's "Allow JavaScript from Apple Events"
 * setting. The Apple Event itself is what makes macOS show its permission
 * prompt, so call this only from an explicit user action.
 */
export async function probeSafariControl(): Promise<SafariControlStatus> {
  if (process.platform !== 'darwin') return 'unsupported';

  const name = await osascript('tell application "Safari" to get name');
  if (!name.ok) {
    // -1743 is the explicit "not authorised" answer. Anything else (-600 "not
    // running", a timeout) says nothing about the grant, so it stays unknown
    // instead of being reported as a denial.
    if (/-1743|not authori[sz]ed/i.test(name.stderr)) return 'denied';
    return 'unknown';
  }

  // With no window there is nothing to run JavaScript in; automation itself is
  // fine, and the JS setting can only be checked against a real page.
  const documents = await osascript('tell application "Safari" to count documents');
  if (!documents.ok) return 'unknown';
  if (documents.stdout === '0') return 'ok';

  const js = await osascript('tell application "Safari" to do JavaScript "1" in front document');
  if (js.ok && js.stdout === '1') return 'ok';
  if (/do JavaScript|JavaScript from Apple Events|not allowed/i.test(`${js.stdout}\n${js.stderr}`)) return 'no-js';
  return 'unknown';
}

/** Closes the Safari tab the handoff opened, so the user lands back in the app. */
export async function closeSafariTab(host: string): Promise<void> {
  if (process.platform !== 'darwin') return;
  const escaped = host.replace(/["\\]/g, '');
  await osascript(`
tell application "Safari"
  repeat 3 times
    try
      set theDoc to first document whose URL contains "${escaped}"
      close theDoc
    end try
    delay 0.3
  end repeat
end tell
`);
}
