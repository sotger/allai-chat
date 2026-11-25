import type { Session } from 'electron';

import { filterCookiesForHost, type CookieRecord } from '@shared/cookies';
import type { BrowserSignInResult } from '@shared/ipc';

import { writeImportedCookie } from './cookie-import';
import { readSafariCookies } from './safari-cookies';

/**
 * The "sign in in the browser, the browser hands the session back" flow, for
 * services whose only login path needs passkeys (they cannot complete inside
 * Electron). The app opens the service in Safari, then watches Safari's cookie
 * store and imports the service's cookies as soon as the login writes them.
 *
 * Limitations, by design: macOS only, needs Full Disk Access, and the result is
 * a cookie snapshot rather than an SSO handoff.
 */

export interface SafariImportResult {
  imported: number;
  matched: number;
  host: string;
  /** True when a session cookie (not just a device id) was among them. */
  hasSession: boolean;
  error?: 'denied' | 'missing' | 'unreadable' | 'none';
}

/**
 * Cookies that mean "this is the session", as opposed to a device id or cache.
 * This is the ChatGPT rule; services that name the cookie differently declare
 * their own pattern in `ProviderConfig.sessionCookiePattern`.
 */
export const DEFAULT_SESSION_COOKIE_PATTERN = 'session-token|(^|\\.)session$';

/** Compiles a provider's session-cookie rule, falling back to the default. */
export function compileSessionCookiePattern(source?: string): RegExp {
  if (source) {
    try {
      return new RegExp(source, 'i');
    } catch {
      /* a broken pattern must not disable the handoff */
    }
  }
  return new RegExp(DEFAULT_SESSION_COOKIE_PATTERN, 'i');
}

async function writeMatching(session: Session, cookies: CookieRecord[]): Promise<number> {
  let imported = 0;
  for (const cookie of cookies) {
    if (await writeImportedCookie(session, cookie)) imported += 1;
  }
  if (imported > 0) {
    try { await session.cookies.flushStore(); } catch { /* best effort */ }
  }
  return imported;
}

/**
 * One-shot import of whatever Safari currently has for the host. Used by the
 * "take the session now" button and when the browser is already signed in, so
 * the user does not have to repeat a login that already happened.
 */
export async function importSafariSessionNow(
  session: Session,
  host: string,
  sessionCookiePattern?: string
): Promise<SafariImportResult> {
  const read = readSafariCookies();
  if (read.error) return { imported: 0, matched: 0, host, hasSession: false, error: read.error };

  const matching = filterCookiesForHost(read.cookies, host);
  if (matching.length === 0) {
    return { imported: 0, matched: 0, host, hasSession: false, error: 'none' };
  }

  const pattern = compileSessionCookiePattern(sessionCookiePattern);
  const hasSession = matching.some((cookie) => pattern.test(cookie.name));
  const imported = await writeMatching(session, matching);
  return { imported, matched: matching.length, host, hasSession };
}

export interface WatchOptions {
  tabId: string;
  host: string;
  session: Session;
  onDone: (result: BrowserSignInResult) => void;
  /** The service's "signed in" cookie rule; defaults to the ChatGPT one. */
  sessionCookiePattern?: string;
  /** Poll interval; tests shrink it. */
  pollMs?: number;
  /** Give up after this long without a new cookie. */
  deadlineMs?: number;
  /** Diagnostics: called on start, denial, timeout and import. */
  onEvent?: (message: string) => void;
}

const POLL_MS = 1500;
const DEADLINE_MS = 10 * 60 * 1000;

const cookieKey = (cookie: CookieRecord): string =>
  `${cookie.domain}|${cookie.path}|${cookie.name}`;

/**
 * Starts watching for a new session. Returns a cancel function; the watcher
 * stops itself after the first successful import, on a missing Full Disk Access
 * grant, or when the deadline passes.
 */
export function watchSafariSession(options: WatchOptions): () => void {
  const { tabId, host, session, onDone } = options;
  const pollMs = options.pollMs ?? POLL_MS;
  const deadlineMs = options.deadlineMs ?? DEADLINE_MS;
  const sessionPattern = compileSessionCookiePattern(options.sessionCookiePattern);

  const log = options.onEvent ?? (() => undefined);
  const baseline = readSafariCookies();
  if (baseline.error === 'denied') {
    log(`denied while reading Safari cookies (host ${host})`);
    onDone({ tabId, state: 'denied', host });
    return () => undefined;
  }

  const baselineMatching = filterCookiesForHost(baseline.cookies, host);
  log(`start host=${host} baseline=${baselineMatching.length} (${baseline.error ?? 'ok'})`);

  // Cookies that existed before the browser login must not count as new ones.
  const known = new Set(baselineMatching.map(cookieKey));

  let finished = false;
  let lastWaitingLog = 0;
  let timer: NodeJS.Timeout | undefined;
  let deadline: NodeJS.Timeout | undefined;

  const stop = (): void => {
    finished = true;
    if (timer) clearInterval(timer);
    if (deadline) clearTimeout(deadline);
  };

  const finish = (result: BrowserSignInResult): void => {
    if (finished) return;
    stop();
    onDone(result);
  };

  const poll = async (): Promise<void> => {
    if (finished) return;

    const read = readSafariCookies();
    if (read.error === 'denied') {
      finish({ tabId, state: 'denied', host });
      return;
    }

    const matching = filterCookiesForHost(read.cookies, host);

    // Device ids, cache markers and Cloudflare cookies appear the moment the
    // browser opens the page. They are not a login: importing them would reload
    // the tab, end the watch and miss the session that arrives a minute later.
    if (!matching.some((cookie) => sessionPattern.test(cookie.name))) {
      const fresh = matching.filter((cookie) => !known.has(cookieKey(cookie)));
      if (fresh.length > 0 && fresh.length !== lastWaitingLog) {
        lastWaitingLog = fresh.length;
        log(`waiting: ${fresh.length} new cookie(s), no session yet`);
      }
      return;
    }

    // Write the whole matching set, not just the new cookies: the browser may
    // also have refreshed the session token in place.
    const imported = await writeMatching(session, matching);
    if (imported === 0) return;

    log(`imported ${imported} of ${matching.length} cookies for ${host}`);
    finish({ tabId, state: 'imported', imported, host });
  };

  timer = setInterval(() => { void poll(); }, pollMs);
  deadline = setTimeout(() => {
    log(`timeout after ${Math.round(deadlineMs / 1000)}s (last known ${known.size} cookies)`);
    finish({ tabId, state: 'timeout', host });
  }, deadlineMs);

  // Safari is already signed in: take that session instead of waiting for a new
  // login that would never happen.
  if (baselineMatching.some((cookie) => sessionPattern.test(cookie.name))) {
    log('Safari already holds a session for this host');
    void writeMatching(session, baselineMatching).then((imported) => {
      log(`imported ${imported} from the existing Safari session`);
      if (imported > 0) finish({ tabId, state: 'imported', imported, host });
    });
  }

  return stop;
}
