/**
 * Cookie import helpers.
 *
 * The app cannot complete WebAuthn (passkeys, "Sign in with iPhone"), so some
 * services can only be signed in from a real browser. This module turns a
 * browser export into cookie records the main process can write into a tab's
 * partition. Two formats are accepted:
 *
 * - Netscape `cookies.txt` (curl, Cookie-Editor, EditThisCookie, …), where an
 *   `HttpOnly` cookie is written as `#HttpOnly_<domain>`;
 * - a `Cookie:` request header (`name=value; name2=value2`), which has no
 *   domain, so the caller supplies the tab's host.
 */

export interface CookieRecord {
  /** Domain as written in the source, possibly with a leading dot. */
  domain: string;
  /** The cookie also applies to subdomains (Netscape flag or leading dot). */
  includeSubdomains: boolean;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  /** Unix seconds; `undefined` means a session cookie. */
  expirationDate?: number;
  name: string;
  value: string;
}

/** Larger pastes are almost certainly a mistake (or a whole browser profile). */
export const COOKIE_TEXT_MAX_BYTES = 1024 * 1024;

/** Guard rail: a tab never needs more than this many cookies. */
export const COOKIE_IMPORT_MAX = 500;

const NAME_PATTERN = /^[^\s;=]+$/;

function normalizeDomain(value: string): string {
  return value.trim().toLowerCase().replace(/^\.+/, '');
}

function clean(value: string): string {
  return value.replace(/[\r\n\t]/g, '').trim();
}

function record(input: {
  domain: string;
  includeSubdomains: boolean;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  expirationDate?: number;
  name: string;
  value: string;
}): CookieRecord | null {
  const name = clean(input.name);
  const domain = normalizeDomain(input.domain);
  if (!name || !NAME_PATTERN.test(name) || !domain || domain.includes('/')) return null;

  const cookiePath = input.path.startsWith('/') ? input.path : `/${input.path || ''}`;
  return {
    domain,
    includeSubdomains: input.includeSubdomains || input.domain.trim().startsWith('.'),
    path: cookiePath || '/',
    secure: input.secure,
    httpOnly: input.httpOnly,
    expirationDate: input.expirationDate && input.expirationDate > 0 ? input.expirationDate : undefined,
    name,
    value: clean(input.value)
  };
}

function parseNetscapeLine(line: string, httpOnly: boolean): CookieRecord | null {
  // Tabs are the format; some exporters pad with spaces, so fall back to any
  // whitespace run when the tab split does not produce seven fields.
  let fields = line.split('\t');
  if (fields.length < 7) fields = line.split(/\s+/);
  if (fields.length < 7) return null;

  const [domain, flag, cookiePath, secureFlag, expiry] = fields;
  // A value may contain tabs in theory; keep everything after the sixth field.
  const name = fields[5];
  const value = fields.slice(6).join('\t');
  const expires = Number.parseInt(expiry, 10);

  return record({
    domain,
    includeSubdomains: flag.trim().toUpperCase() === 'TRUE',
    path: cookiePath,
    secure: secureFlag.trim().toUpperCase() === 'TRUE',
    httpOnly,
    expirationDate: Number.isFinite(expires) ? expires : undefined,
    name,
    value
  });
}

/** `name=value; name2=value2`, optionally prefixed with `Cookie:`. */
function parseHeaderLine(line: string, domain: string | undefined): CookieRecord[] {
  const withoutPrefix = line.replace(/^\s*cookie\s*:/i, '');
  if (!domain) return [];

  const cookies: CookieRecord[] = [];
  for (const part of withoutPrefix.split(';')) {
    const trimmed = part.trim();
    const equals = trimmed.indexOf('=');
    if (equals <= 0) continue;
    const parsed = record({
      domain,
      includeSubdomains: false,
      path: '/',
      secure: true,
      // A `Cookie:` header cannot tell us, and browser sessions are HttpOnly.
      httpOnly: true,
      name: trimmed.slice(0, equals),
      value: trimmed.slice(equals + 1)
    });
    if (parsed) cookies.push(parsed);
  }
  return cookies;
}

/**
 * Parses a pasted export. `defaultDomain` is used only for `Cookie:` header
 * input, which carries no domain of its own.
 */
export function parseCookieText(text: string, defaultDomain?: string): CookieRecord[] {
  const source = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const byKey = new Map<string, CookieRecord>();

  for (const rawLine of source.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;

    const httpOnly = /^#HttpOnly_/i.test(line);
    const body = httpOnly ? line.replace(/^#HttpOnly_/i, '') : line;
    if (!httpOnly && body.startsWith('#')) continue;

    const parsed = body.includes('\t') || body.split(/\s+/).length >= 7
      ? [parseNetscapeLine(body, httpOnly)].filter((item): item is CookieRecord => item !== null)
      : parseHeaderLine(body, defaultDomain);

    for (const cookie of parsed) {
      byKey.set(`${cookie.domain}|${cookie.path}|${cookie.name}`, cookie);
    }
  }

  return [...byKey.values()];
}

/**
 * True when a cookie stored for `domain` can be set on a page of `host`:
 * same host, a subdomain of the cookie's domain, or a parent of it.
 */
export function cookieMatchesHost(domain: string, host: string): boolean {
  const cookieHost = normalizeDomain(domain);
  const pageHost = normalizeDomain(host);
  if (!cookieHost || !pageHost) return false;
  return cookieHost === pageHost
    || pageHost.endsWith(`.${cookieHost}`)
    || cookieHost.endsWith(`.${pageHost}`);
}

/** Cookies that belong to the tab's service; the rest of the paste is ignored. */
export function filterCookiesForHost(cookies: CookieRecord[], host: string): CookieRecord[] {
  if (!host) return [];
  return cookies.filter((cookie) => cookieMatchesHost(cookie.domain, host));
}
