import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import type { CookieRecord } from '@shared/cookies';

import {
  COOKIE_FLAG_HTTP_ONLY,
  COOKIE_FLAG_SECURE,
  parseBinaryCookies,
  readSafariCookies,
  safariCookieFolderReadable
} from './safari-cookies';

type CookieInput = Pick<CookieRecord, 'domain' | 'name' | 'path' | 'value'> & {
  flags?: number;
  /** Seconds since 2001-01-01, the way Safari stores it. */
  expires?: number;
};

function cookieBuffer(input: CookieInput): Buffer {
  const strings = [input.domain, input.name, input.path, input.value]
    .map((value) => Buffer.from(`${value}\0`, 'utf8'));
  const headerSize = 56;
  const offsets: number[] = [];
  let cursor = headerSize;
  for (const string of strings) {
    offsets.push(cursor);
    cursor += string.length;
  }

  const buffer = Buffer.alloc(cursor);
  buffer.writeUInt32LE(cursor, 0);
  buffer.writeUInt32LE(0, 4);
  buffer.writeUInt32LE(input.flags ?? 0, 8);
  buffer.writeUInt32LE(0, 12);
  buffer.writeUInt32LE(offsets[0], 16);
  buffer.writeUInt32LE(offsets[1], 20);
  buffer.writeUInt32LE(offsets[2], 24);
  buffer.writeUInt32LE(offsets[3], 28);
  buffer.writeUInt32LE(0, 32);
  buffer.writeUInt32LE(0, 36);
  buffer.writeDoubleLE(input.expires ?? 0, 40);
  buffer.writeDoubleLE(0, 48);
  Buffer.concat(strings).copy(buffer, headerSize);
  return buffer;
}

/** Builds a `cook` file with one page holding the given cookies. */
function cookieFile(cookies: CookieInput[]): Buffer {
  const bodies = cookies.map(cookieBuffer);
  const pageHeader = Buffer.alloc(8 + bodies.length * 4);
  pageHeader.writeUInt32LE(0x100, 0);
  pageHeader.writeUInt32LE(bodies.length, 4);
  let offset = 8 + bodies.length * 4;
  bodies.forEach((body, index) => {
    pageHeader.writeUInt32LE(offset, 8 + index * 4);
    offset += body.length;
  });

  const page = Buffer.concat([pageHeader, ...bodies]);
  const file = Buffer.alloc(8 + 4);
  file.write('cook', 0, 'latin1');
  file.writeUInt32BE(1, 4);
  file.writeUInt32BE(page.length, 8);
  return Buffer.concat([file, page]);
}

const directories: string[] = [];
function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'allai-safari-'));
  directories.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of directories.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('parseBinaryCookies', () => {
  it('reads names, values, flags and converts the 2001 epoch', () => {
    const cookies = parseBinaryCookies(cookieFile([
      {
        domain: '.chatgpt.com',
        name: '__Secure-authjs.session-token',
        path: '/',
        value: 'eyJhbGci',
        flags: COOKIE_FLAG_SECURE | COOKIE_FLAG_HTTP_ONLY,
        expires: 800_000_000
      }
    ]));

    expect(cookies).toHaveLength(1);
    expect(cookies[0]).toMatchObject({
      domain: 'chatgpt.com',
      includeSubdomains: true,
      name: '__Secure-authjs.session-token',
      value: 'eyJhbGci',
      path: '/',
      secure: true,
      httpOnly: true
    });
    // 800000000 seconds after 2001-01-01 is 2026-05-05 UTC.
    expect(cookies[0].expirationDate).toBe(800_000_000 + 978_307_200);
  });

  it('keeps host-only cookies host-only and session cookies without expiry', () => {
    const [cookie] = parseBinaryCookies(cookieFile([
      { domain: 'chatgpt.com', name: 'oai-did', path: '/', value: 'abc' }
    ]));
    expect(cookie.includeSubdomains).toBe(false);
    expect(cookie.secure).toBe(false);
    expect(cookie.httpOnly).toBe(false);
    expect(cookie.expirationDate).toBeUndefined();
  });

  it('reads several cookies from one page', () => {
    const cookies = parseBinaryCookies(cookieFile([
      { domain: '.chatgpt.com', name: 'a', path: '/', value: '1' },
      { domain: '.chatgpt.com', name: 'b', path: '/c/', value: '2' }
    ]));
    expect(cookies.map((cookie) => cookie.name)).toEqual(['a', 'b']);
    expect(cookies[1].path).toBe('/c/');
  });

  it('rejects files that are not Safari cookie stores', () => {
    expect(() => parseBinaryCookies(Buffer.from('nope'))).toThrow(/Safari cookie file/);
  });

  it('survives a truncated page', () => {
    const file = cookieFile([{ domain: '.chatgpt.com', name: 'a', path: '/', value: '1' }]);
    expect(() => parseBinaryCookies(file.subarray(0, file.length - 6))).not.toThrow();
  });
});

describe('readSafariCookies', () => {
  it('reads the first existing candidate', () => {
    const dir = tempDir();
    const file = path.join(dir, 'Cookies.binarycookies');
    fs.writeFileSync(file, cookieFile([
      { domain: '.chatgpt.com', name: 'session', path: '/', value: 'x' }
    ]));

    const read = readSafariCookies([path.join(dir, 'missing'), file]);
    expect(read.path).toBe(file);
    expect(read.cookies.map((cookie) => cookie.name)).toEqual(['session']);
  });

  it('reports missing and unreadable files separately', () => {
    const dir = tempDir();
    expect(readSafariCookies([path.join(dir, 'missing')]).error).toBe('missing');

    const corrupt = path.join(dir, 'corrupt');
    fs.writeFileSync(corrupt, 'not a cookie file');
    expect(readSafariCookies([corrupt]).error).toBe('unreadable');
  });
});

describe('safariCookieFolderReadable', () => {
  // Full Disk Access is checked through the folder because Safari may not have
  // written a cookie file yet; an absent folder means the grant is unknowable.
  it('leaves the grant unknown when Safari has no cookie folder', () => {
    expect(safariCookieFolderReadable(tempDir())).toBeUndefined();
  });

  it('treats a listable cookie folder as granted', () => {
    const home = tempDir();
    fs.mkdirSync(
      path.join(home, 'Library/Containers/com.apple.Safari/Data/Library/Cookies'),
      { recursive: true }
    );
    expect(safariCookieFolderReadable(home)).toBe(true);
  });
});
