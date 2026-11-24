import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { CookieRecord } from '@shared/cookies';

/**
 * Safari stores cookies in a binary "cookies.binarycookies" file: a page table
 * followed by cookie pages with length-prefixed, NUL-terminated strings. Reading
 * it requires Full Disk Access for the app; without the grant macOS throws EPERM
 * and the caller falls back to the manual paste import.
 *
 * Format reference: `cook` magic, uint32BE page count, uint32BE page sizes, then
 * each page with a uint32LE cookie count and uint32LE cookie offsets. A cookie
 * carries flags (bit 0 secure, bit 2 HttpOnly), five string offsets and two
 * float64 timestamps measured from 2001-01-01 UTC.
 */

/** Seconds between 1970-01-01 and 2001-01-01, Safari's timestamp epoch. */
const SAFARI_EPOCH_OFFSET = 978307200;

export const COOKIE_FLAG_SECURE = 1;
export const COOKIE_FLAG_HTTP_ONLY = 4;

export function parseBinaryCookies(buffer: Buffer): CookieRecord[] {
  if (buffer.length < 8 || buffer.toString('latin1', 0, 4) !== 'cook') {
    throw new Error('not a Safari cookie file');
  }

  const pageCount = buffer.readUInt32BE(4);
  if (pageCount === 0 || pageCount > 100_000) throw new Error('unexpected page count');

  const pageSizes: number[] = [];
  let cursor = 8;
  for (let index = 0; index < pageCount; index += 1) {
    if (cursor + 4 > buffer.length) throw new Error('truncated page table');
    pageSizes.push(buffer.readUInt32BE(cursor));
    cursor += 4;
  }

  const cookies: CookieRecord[] = [];
  for (const size of pageSizes) {
    const pageEnd = cursor + size;
    if (size < 8 || pageEnd > buffer.length) break;
    const page = buffer.subarray(cursor, pageEnd);
    cursor = pageEnd;

    const count = page.readUInt32LE(4);
    for (let index = 0; index < count; index += 1) {
      const offsetPosition = 8 + index * 4;
      if (offsetPosition + 4 > page.length) break;
      const cookie = readCookie(page, page.readUInt32LE(offsetPosition));
      if (cookie) cookies.push(cookie);
    }
  }

  return cookies;
}

function readString(cookie: Buffer, offset: number): string {
  if (offset <= 0 || offset >= cookie.length) return '';
  const end = cookie.indexOf(0, offset);
  return cookie.toString('utf8', offset, end === -1 ? cookie.length : end);
}

function readCookie(page: Buffer, start: number): CookieRecord | null {
  if (start + 56 > page.length) return null;
  const cookie = page.subarray(start);

  const flags = cookie.readUInt32LE(8);
  const domain = readString(cookie, cookie.readUInt32LE(16));
  const name = readString(cookie, cookie.readUInt32LE(20));
  const cookiePath = readString(cookie, cookie.readUInt32LE(24)) || '/';
  const value = readString(cookie, cookie.readUInt32LE(28));
  const expires = cookie.readDoubleLE(40);

  if (!name || !domain) return null;

  const expirationDate = expires > 0 ? Math.round(expires + SAFARI_EPOCH_OFFSET) : undefined;
  return {
    domain: domain.replace(/^\./, ''),
    includeSubdomains: domain.startsWith('.'),
    path: cookiePath.startsWith('/') ? cookiePath : `/${cookiePath}`,
    secure: (flags & COOKIE_FLAG_SECURE) !== 0,
    httpOnly: (flags & COOKIE_FLAG_HTTP_ONLY) !== 0,
    expirationDate,
    name,
    value
  };
}

/** Candidate locations, newest Safari layout first. */
export function safariCookiePaths(home = os.homedir()): string[] {
  return [
    path.join(home, 'Library/Containers/com.apple.Safari/Data/Library/Cookies/Cookies.binarycookies'),
    path.join(home, 'Library/Cookies/Cookies.binarycookies')
  ];
}

export interface SafariCookieRead {
  cookies: CookieRecord[];
  path?: string;
  /** `denied` means macOS blocked the read: Full Disk Access is missing. */
  error?: 'missing' | 'denied' | 'unreadable';
}

/** Reads and parses Safari's cookie store. Never throws. */
export function readSafariCookies(paths: string[] = safariCookiePaths()): SafariCookieRead {
  let onlyMissing = true;

  for (const candidate of paths) {
    let buffer: Buffer;
    try {
      buffer = fs.readFileSync(candidate);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'EACCES' || code === 'EPERM') return { cookies: [], error: 'denied' };
      continue;
    }

    onlyMissing = false;
    try {
      return { cookies: parseBinaryCookies(buffer), path: candidate };
    } catch {
      continue;
    }
  }

  return { cookies: [], error: onlyMissing ? 'missing' : 'unreadable' };
}
