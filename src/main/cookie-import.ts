import type { CookiesSetDetails, Session } from 'electron';

import {
  COOKIE_IMPORT_MAX,
  COOKIE_TEXT_MAX_BYTES,
  filterCookiesForHost,
  parseCookieText,
  type CookieRecord
} from '@shared/cookies';

export interface CookieImportOutcome {
  /** Cookies found in the pasted text. */
  total: number;
  /** Cookies that belong to the tab's host. */
  matched: number;
  /** Cookies the session accepted. */
  imported: number;
  host: string;
  /** Set when nothing could be imported for a structural reason. */
  error?: 'empty' | 'no-host' | 'too-large';
}

function cookieUrl(cookie: CookieRecord): string {
  const scheme = cookie.secure ? 'https' : 'http';
  return `${scheme}://${cookie.domain}${cookie.path}`;
}

/** Writes one parsed cookie into a session. Returns false when it is not valid. */
export async function writeImportedCookie(ses: Session, cookie: CookieRecord): Promise<boolean> {
  if (cookie.expirationDate && cookie.expirationDate <= Date.now() / 1000) return false;

  const details: CookiesSetDetails = {
    url: cookieUrl(cookie),
    name: cookie.name,
    value: cookie.value,
    path: cookie.path,
    secure: cookie.secure,
    httpOnly: cookie.httpOnly,
    sameSite: 'unspecified'
  };
  if (cookie.includeSubdomains) details.domain = cookie.domain;
  if (cookie.expirationDate) details.expirationDate = cookie.expirationDate;

  try {
    await ses.cookies.set(details);
    return true;
  } catch {
    return false;
  }
}

/**
 * Imports cookies from a browser export into the session that backs one tab.
 * Only cookies belonging to the tab's host are written; everything else in the
 * paste is ignored so a stray `cookies.txt` cannot drop another site's session
 * into this profile.
 */
export async function importCookiesIntoTab(
  ses: Session,
  host: string,
  text: string
): Promise<CookieImportOutcome> {
  const serviceHost = host.trim().toLowerCase();
  if (!serviceHost) return { total: 0, matched: 0, imported: 0, host: '', error: 'no-host' };
  if (text.length > COOKIE_TEXT_MAX_BYTES) {
    return { total: 0, matched: 0, imported: 0, host: serviceHost, error: 'too-large' };
  }

  const cookies = parseCookieText(text, serviceHost);
  if (cookies.length === 0) {
    return { total: 0, matched: 0, imported: 0, host: serviceHost, error: 'empty' };
  }

  const matched = filterCookiesForHost(cookies, serviceHost).slice(0, COOKIE_IMPORT_MAX);
  let imported = 0;
  for (const cookie of matched) {
    if (await writeImportedCookie(ses, cookie)) imported += 1;
  }

  if (imported > 0) {
    try { await ses.cookies.flushStore(); } catch { /* best effort */ }
  }

  return { total: cookies.length, matched: matched.length, imported, host: serviceHost };
}

/** Host a tab's cookies should be matched against. */
export function tabHost(url: string | undefined): string {
  if (!url) return '';
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}
