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
    // `domain: 'google.com'` covers the domain-wide session cookies. The URL
    // filters also pick up host-only cookies on the login hosts themselves.
    const groups = await Promise.all([
      ses.cookies.get({ domain: 'google.com' }),
      ses.cookies.get({ url: 'https://accounts.google.com/' }),
      ses.cookies.get({ url: 'https://www.google.com/' })
    ]);
    const merged = new Map<string, Cookie>();
    for (const cookie of groups.flat()) {
      const key = `${cookie.domain ?? ''}|${cookie.path ?? ''}|${cookie.name}`;
      merged.set(key, cookie);
    }
    return [...merged.values()];
  } catch {
    return [];
  }
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
