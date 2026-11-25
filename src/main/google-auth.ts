import { createHash } from 'node:crypto';

import type { Cookie, CookiesSetDetails, Session } from 'electron';

import { isGoogleAuthCookieName } from '@shared/google-auth';

/** A persistent, app-owned profile that only stores the Google session. */
export const GOOGLE_SIGNIN_PARTITION = 'persist:allai-google-signin';

function cookieHost(cookie: Cookie): string | undefined {
  const host = (cookie.domain || '').replace(/^\./, '');
  return host || undefined;
}

function cookieUrl(cookie: Cookie): string | undefined {
  const host = cookieHost(cookie);
  if (!host) return undefined;
  const cookiePath = cookie.path?.startsWith('/') ? cookie.path : `/${cookie.path ?? ''}`;
  return `https://${host}${cookiePath || '/'}`;
}

export async function readGoogleCookies(ses: Session): Promise<Cookie[]> {
  try {
    // Every Google host, not just the three that carry the login: Google keeps
    // extra accounts and per-property state spread over its subdomains, and a
    // partial copy loses the account chooser.
    const all = await ses.cookies.get({});
    return all.filter((cookie) => isGoogleDomain(cookie.domain));
  } catch {
    return [];
  }
}

function isGoogleDomain(domain: string | undefined): boolean {
  const host = (domain ?? '').replace(/^\./, '').toLowerCase();
  return host === 'google.com' || host.endsWith('.google.com');
}

export function isSignedInToGoogle(cookies: Cookie[]): boolean {
  const now = Date.now() / 1000;
  return cookies.some((cookie) =>
    isGoogleAuthCookieName(cookie.name)
    && (!cookie.expirationDate || cookie.expirationDate > now)
  );
}

export async function hasGoogleSession(ses: Session): Promise<boolean> {
  return isSignedInToGoogle(await readGoogleCookies(ses));
}

/** Cookies that identify the login itself, most stable first. */
const SESSION_COOKIE_NAMES = ['SID', '__Secure-1PSID', '__Secure-3PSID'];

/**
 * A short, non-reversible fingerprint of the Google login behind a cookie set.
 *
 * Google keeps the additional accounts server-side, keyed by this one session
 * cookie, so adding or removing an account does not change the value; signing in
 * as somebody else does. That is exactly the question the vault guard asks.
 * Returns undefined when no session cookie is present.
 */
export function fingerprintGoogleSession(
  cookies: Array<Pick<Cookie, 'name' | 'value'>>
): string | undefined {
  for (const name of SESSION_COOKIE_NAMES) {
    const match = cookies.find((cookie) => cookie.name === name);
    if (match?.value) {
      return createHash('sha256').update(match.value).digest('hex').slice(0, 16);
    }
  }
  return undefined;
}

/** Writes one cookie into another session. Returns false for unsettable cookies. */
export async function writeCookie(target: Session, cookie: Cookie): Promise<boolean> {
  const url = cookieUrl(cookie);
  if (!url) return false;

  if (cookie.expirationDate && cookie.expirationDate <= Date.now() / 1000) return false;

  const details: CookiesSetDetails = {
    url,
    name: cookie.name,
    value: cookie.value,
    path: cookie.path,
    secure: cookie.secure,
    httpOnly: cookie.httpOnly,
    sameSite: cookie.sameSite
  };
  if (!cookie.hostOnly && cookie.domain) details.domain = cookie.domain;
  if (cookie.expirationDate) details.expirationDate = cookie.expirationDate;

  try {
    await target.cookies.set(details);
    return true;
  } catch {
    return false;
  }
}

/**
 * Copies Google cookies from one session to another. Returns the number of
 * cookies that were written. Callers decide whether overwriting an existing
 * Google session is acceptable.
 */
export async function copyGoogleCookies(source: Session, target: Session): Promise<number> {
  if (source === target) return 0;
  const cookies = await readGoogleCookies(source);
  if (!isSignedInToGoogle(cookies)) return 0;

  let written = 0;
  for (const cookie of cookies) {
    if (await writeCookie(target, cookie)) written += 1;
  }
  if (written > 0) {
    try { await target.cookies.flushStore(); } catch { /* ignore */ }
  }
  return written;
}
