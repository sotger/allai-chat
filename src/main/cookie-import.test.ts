import type { CookiesSetDetails, Session } from 'electron';
import { describe, expect, it, vi } from 'vitest';

import { importCookiesIntoTab, tabHost, writeImportedCookie } from './cookie-import';

interface FakeSession {
  session: Session;
  writes: CookiesSetDetails[];
  flushStore: ReturnType<typeof vi.fn>;
}

function fakeSession(fail?: (details: CookiesSetDetails) => boolean): FakeSession {
  const writes: CookiesSetDetails[] = [];
  const flushStore = vi.fn(async () => undefined);
  const session = {
    cookies: {
      set: async (details: CookiesSetDetails) => {
        if (fail?.(details)) throw new Error('rejected');
        writes.push(details);
      },
      flushStore
    }
  } as unknown as Session;
  return { session, writes, flushStore };
}

const JAR = [
  '# Netscape HTTP Cookie File',
  '.chatgpt.com\tTRUE\t/\tTRUE\t1999999999\t__Secure-authjs.session-token\teyJhbGci',
  '#HttpOnly_.chatgpt.com\tTRUE\t/\tTRUE\t1999999999\toai-did\tabc',
  'example.com\tFALSE\t/\tFALSE\t1999999999\tother\t1'
].join('\n');

describe('importCookiesIntoTab', () => {
  it('writes only the cookies that belong to the tab host', async () => {
    const { session, writes, flushStore } = fakeSession();
    const result = await importCookiesIntoTab(session, 'chatgpt.com', JAR);

    expect(result).toMatchObject({ total: 3, matched: 2, imported: 2, host: 'chatgpt.com' });
    expect(result.error).toBeUndefined();
    expect(writes.map((details) => details.name).sort()).toEqual([
      '__Secure-authjs.session-token',
      'oai-did'
    ]);
    expect(flushStore).toHaveBeenCalledTimes(1);
  });

  it('carries the domain, path, secure and HttpOnly flags through', async () => {
    const { session, writes } = fakeSession();
    await importCookiesIntoTab(session, 'chatgpt.com', JAR);

    const device = writes.find((details) => details.name === 'oai-did');
    expect(device).toMatchObject({
      url: 'https://chatgpt.com/',
      domain: 'chatgpt.com',
      path: '/',
      secure: true,
      httpOnly: true
    });
  });

  it('ignores expired cookies', async () => {
    const { session, writes, flushStore } = fakeSession();
    const expired = 'chatgpt.com\tFALSE\t/\tTRUE\t100\told\t1';
    const result = await importCookiesIntoTab(session, 'chatgpt.com', expired);

    expect(result).toMatchObject({ total: 1, matched: 1, imported: 0 });
    expect(writes).toHaveLength(0);
    expect(flushStore).not.toHaveBeenCalled();
  });

  it('reports cookies the session rejects instead of throwing', async () => {
    const { session } = fakeSession((details) => details.name === 'oai-did');
    const result = await importCookiesIntoTab(session, 'chatgpt.com', JAR);
    expect(result).toMatchObject({ matched: 2, imported: 1 });
  });

  it('accepts a Cookie header for the tab host', async () => {
    const { session, writes } = fakeSession();
    const result = await importCookiesIntoTab(session, 'chatgpt.com', 'Cookie: a=1; b=2');

    expect(result).toMatchObject({ total: 2, matched: 2, imported: 2 });
    expect(writes.every((details) => details.url === 'https://chatgpt.com/')).toBe(true);
  });

  it('refuses structurally useless input', async () => {
    const { session } = fakeSession();
    await expect(importCookiesIntoTab(session, '', JAR)).resolves.toMatchObject({ error: 'no-host' });
    await expect(importCookiesIntoTab(session, 'chatgpt.com', 'nothing here')).resolves.toMatchObject({
      error: 'empty'
    });
    const huge = 'x'.repeat(1024 * 1024 + 1);
    await expect(importCookiesIntoTab(session, 'chatgpt.com', huge)).resolves.toMatchObject({
      error: 'too-large'
    });
  });
});

describe('writeImportedCookie', () => {
  it('skips a cookie that has already expired', async () => {
    const { session, writes } = fakeSession();
    const written = await writeImportedCookie(session, {
      domain: 'chatgpt.com',
      includeSubdomains: true,
      path: '/',
      secure: true,
      httpOnly: true,
      expirationDate: 1,
      name: 'k',
      value: 'v'
    });
    expect(written).toBe(false);
    expect(writes).toHaveLength(0);
  });
});

describe('tabHost', () => {
  it('extracts the host and tolerates garbage', () => {
    expect(tabHost('https://chatgpt.com/c/1')).toBe('chatgpt.com');
    expect(tabHost(undefined)).toBe('');
    expect(tabHost('not a url')).toBe('');
  });
});
