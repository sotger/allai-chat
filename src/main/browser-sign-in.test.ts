import type { CookiesSetDetails, Session } from 'electron';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { CookieRecord } from '@shared/cookies';
import { getProviderConfig } from '@shared/providers';
import type { BrowserSignInResult } from '@shared/ipc';

vi.mock('./safari-cookies', () => ({ readSafariCookies: vi.fn() }));

import { compileSessionCookiePattern, importSafariGoogleSession, importSafariSessionNow, readSafariGoogleSession, readSafariGoogleState, watchSafariSession } from './browser-sign-in';
import { readSafariCookies } from './safari-cookies';

const read = vi.mocked(readSafariCookies);

/** The rule the app ships for Gemini; Google has no "*session-token" cookie. */
const GOOGLE_PATTERN = getProviderConfig('gemini').sessionCookiePattern;

interface FakeSession {
  session: Session;
  writes: CookiesSetDetails[];
}

function fakeSession(): FakeSession {
  const writes: CookiesSetDetails[] = [];
  return {
    writes,
    session: {
      cookies: {
        set: async (details: CookiesSetDetails) => { writes.push(details); },
        flushStore: async () => undefined
      }
    } as unknown as Session
  };
}

function cookie(name: string, value = 'v'): CookieRecord {
  return {
    domain: 'chatgpt.com',
    includeSubdomains: true,
    path: '/',
    secure: true,
    httpOnly: true,
    expirationDate: 4_000_000_000,
    name,
    value
  };
}

function waitForResult(): { promise: Promise<BrowserSignInResult>; done: (result: BrowserSignInResult) => void } {
  let resolve!: (result: BrowserSignInResult) => void;
  const promise = new Promise<BrowserSignInResult>((res) => { resolve = res; });
  return { promise, done: resolve };
}

describe('watchSafariSession', () => {
  beforeEach(() => {
    read.mockReset();
  });

  it('reports a missing Full Disk Access grant immediately', async () => {
    read.mockReturnValue({ cookies: [], error: 'denied' });
    const { session } = fakeSession();
    const result = waitForResult();

    watchSafariSession({ tabId: 't', host: 'chatgpt.com', session, onDone: result.done });
    await expect(result.promise).resolves.toMatchObject({ state: 'denied', tabId: 't' });
  });

  it('imports the matching cookies once the browser writes a new one', async () => {
    const initial = [cookie('oai-did')];
    read.mockReturnValueOnce({ cookies: initial, path: '/tmp/x' });
    read.mockReturnValue({ cookies: [...initial, cookie('__Secure-authjs.session-token', 'JWT')], path: '/tmp/x' });

    const { session, writes } = fakeSession();
    const result = waitForResult();

    let stop: () => void = () => undefined;
    stop = watchSafariSession({
      tabId: 't',
      host: 'chatgpt.com',
      session,
      pollMs: 5,
      deadlineMs: 500,
      onDone: (done) => { stop(); result.done(done); }
    });

    await expect(result.promise).resolves.toMatchObject({ state: 'imported', host: 'chatgpt.com' });
    expect(writes.some((details) => details.name === '__Secure-authjs.session-token')).toBe(true);
  });

  it('ignores cookies that existed before the flow and cookies of other sites', async () => {
    const initial = [cookie('oai-did')];
    read.mockReturnValue({
      cookies: [...initial, { ...cookie('other'), domain: 'example.com' }],
      path: '/tmp/x'
    });

    const { session, writes } = fakeSession();
    const result = waitForResult();

    watchSafariSession({
      tabId: 't',
      host: 'chatgpt.com',
      session,
      pollMs: 5,
      deadlineMs: 40,
      onDone: result.done
    });

    await expect(result.promise).resolves.toMatchObject({ state: 'timeout' });
    expect(writes).toHaveLength(0);
  });

  it('imports right away when Safari is already signed in', async () => {
    read.mockReturnValue({
      cookies: [cookie('oai-did'), cookie('__Secure-next-auth.session-token.0', 'JWT')],
      path: '/tmp/x'
    });

    const { session, writes } = fakeSession();
    const result = waitForResult();

    watchSafariSession({
      tabId: 't',
      host: 'chatgpt.com',
      session,
      pollMs: 50,
      deadlineMs: 500,
      onDone: result.done
    });

    await expect(result.promise).resolves.toMatchObject({ state: 'imported', imported: 2 });
    expect(writes.some((details) => details.name === '__Secure-next-auth.session-token.0')).toBe(true);
  });

  it('does not end the watch on newly arrived non-session cookies', async () => {
    // Safari writes oai-did / cf_clearance as soon as the page opens; the real
    // session only appears after the login round-trip.
    read.mockReturnValueOnce({ cookies: [], path: '/tmp/x' });
    read.mockReturnValue({ cookies: [cookie('oai-did'), cookie('cf_clearance')], path: '/tmp/x' });

    const { session, writes } = fakeSession();
    const onDone = vi.fn();

    const stop = watchSafariSession({
      tabId: 't',
      host: 'chatgpt.com',
      session,
      pollMs: 5,
      deadlineMs: 500,
      onDone
    });

    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(onDone).not.toHaveBeenCalled();
    expect(writes).toHaveLength(0);

    read.mockReturnValue({
      cookies: [cookie('oai-did'), cookie('cf_clearance'), cookie('__Secure-next-auth.session-token.0', 'JWT')],
      path: '/tmp/x'
    });
    await new Promise((resolve) => setTimeout(resolve, 40));
    stop();

    expect(onDone).toHaveBeenCalledWith(expect.objectContaining({ state: 'imported' }));
    expect(writes.some((details) => details.name === '__Secure-next-auth.session-token.0')).toBe(true);
  });

  it('stops polling when canceled', async () => {
    read.mockReturnValue({ cookies: [cookie('oai-did')], path: '/tmp/x' });
    const { session } = fakeSession();
    const onDone = vi.fn();

    const stop = watchSafariSession({
      tabId: 't',
      host: 'chatgpt.com',
      session,
      pollMs: 5,
      deadlineMs: 30,
      onDone
    });
    stop();

    read.mockReturnValue({ cookies: [cookie('oai-did'), cookie('session')], path: '/tmp/x' });
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(onDone).not.toHaveBeenCalled();
  });

  it('accepts a provider-specific session cookie (Google) on a child host', async () => {
    // Gemini's session lives in Google's cookies on .google.com; the ChatGPT
    // rule would never match them, so the provider declares its own.
    const googleCookie = (name: string): CookieRecord => ({
      ...cookie(name),
      domain: 'google.com'
    });

    read.mockReturnValueOnce({ cookies: [], path: '/tmp/x' });
    read.mockReturnValue({ cookies: [googleCookie('NID'), googleCookie('__Secure-1PSID')], path: '/tmp/x' });

    const { session, writes } = fakeSession();
    const result = waitForResult();

    let stop: () => void = () => undefined;
    stop = watchSafariSession({
      tabId: 't',
      host: 'gemini.google.com',
      session,
      sessionCookiePattern: GOOGLE_PATTERN,
      pollMs: 5,
      deadlineMs: 500,
      onDone: (done) => { stop(); result.done(done); }
    });

    await expect(result.promise).resolves.toMatchObject({ state: 'imported', host: 'gemini.google.com' });
    expect(writes.some((details) => details.name === '__Secure-1PSID')).toBe(true);
  });

  it('imports a Supabase auth-token for a custom service', async () => {
    // seedance.ai signs in through Supabase; its session is
    // `sb-<ref>-auth-token`, which the ChatGPT rule never matched, so the
    // handoff waited out the whole 10-minute deadline (2026-11-27).
    const seedance = (name: string): CookieRecord => ({ ...cookie(name), domain: 'www.seedance.ai' });
    const verifier = seedance('sb-stcyczqlqaveeyocpvop-auth-token-code-verifier');
    const token = seedance('sb-stcyczqlqaveeyocpvop-auth-token');

    read.mockReturnValueOnce({ cookies: [], path: '/tmp/x' });
    read.mockReturnValue({ cookies: [verifier, token], path: '/tmp/x' });

    const { session, writes } = fakeSession();
    const result = waitForResult();

    let stop: () => void = () => undefined;
    stop = watchSafariSession({
      tabId: 't',
      host: 'www.seedance.ai',
      session,
      pollMs: 5,
      deadlineMs: 500,
      onDone: (done) => { stop(); result.done(done); }
    });

    await expect(result.promise).resolves.toMatchObject({ state: 'imported', host: 'www.seedance.ai' });
    expect(writes.some((details) => details.name === 'sb-stcyczqlqaveeyocpvop-auth-token')).toBe(true);
  });

  it('keeps waiting while only the Supabase code verifier appeared', async () => {
    const verifier: CookieRecord = {
      ...cookie('sb-stcyczqlqaveeyocpvop-auth-token-code-verifier'),
      domain: 'www.seedance.ai'
    };
    read.mockReturnValue({ cookies: [verifier], path: '/tmp/x' });

    const { session, writes } = fakeSession();
    const onDone = vi.fn();

    const stop = watchSafariSession({
      tabId: 't',
      host: 'www.seedance.ai',
      session,
      pollMs: 5,
      deadlineMs: 500,
      onDone
    });

    await new Promise((resolve) => setTimeout(resolve, 40));
    stop();
    expect(onDone).not.toHaveBeenCalled();
    expect(writes).toHaveLength(0);
  });
});

describe('default session cookie rule', () => {
  it('treats a Supabase auth-token as a session but not its code verifier', () => {
    const pattern = compileSessionCookiePattern();
    expect(pattern.test('sb-stcyczqlqaveeyocpvop-auth-token')).toBe(true);
    expect(pattern.test('sb-stcyczqlqaveeyocpvop-auth-token.0')).toBe(true);
    expect(pattern.test('sb-stcyczqlqaveeyocpvop-auth-token-code-verifier')).toBe(false);
    expect(pattern.test('__Host-id-token-nonce')).toBe(false);
    expect(pattern.test('oai-did')).toBe(false);
  });
});

describe('readSafariGoogleState', () => {
  beforeEach(() => {
    read.mockReset();
  });

  const googleCookie = (name: string): CookieRecord => ({ ...cookie(name), domain: 'google.com' });

  it('reports the live browser login and its cookies', () => {
    read.mockReturnValue({ cookies: [googleCookie('NID'), googleCookie('SID')], path: '/tmp/x' });
    const status = readSafariGoogleState();
    expect(status.state).toBe('signed-in');
    expect(status.cookies.map((item) => item.name)).toContain('SID');
    expect(status.session).toBeTruthy();
  });

  it('reports signed-out when the browser has no Google session left', () => {
    // Clearing Safari's cookies must make the vault snapshot look stale, not
    // leave the app answering Google sign-ins from a login the user removed.
    read.mockReturnValue({ cookies: [{ ...cookie('_ga'), domain: 'seedance.ai' }], path: '/tmp/x' });
    expect(readSafariGoogleState()).toMatchObject({ state: 'signed-out', cookies: [] });
  });

  it('reports signed-out when Safari has no cookie store at all', () => {
    read.mockReturnValue({ cookies: [], error: 'missing' });
    expect(readSafariGoogleState().state).toBe('signed-out');
  });

  it('reports unknown when the store cannot be read', () => {
    read.mockReturnValue({ cookies: [], error: 'denied' });
    expect(readSafariGoogleState().state).toBe('unknown');
  });
});

describe('importSafariSessionNow', () => {
  beforeEach(() => {
    read.mockReset();
  });

  it('writes every matching cookie once', async () => {
    read.mockReturnValue({
      cookies: [cookie('oai-did'), cookie('session'), { ...cookie('x'), domain: 'example.com' }],
      path: '/tmp/x'
    });
    const { session, writes } = fakeSession();

    await expect(importSafariSessionNow(session, 'chatgpt.com')).resolves.toMatchObject({
      imported: 2,
      matched: 2,
      host: 'chatgpt.com'
    });
    expect(writes).toHaveLength(2);
  });

  it('flags a cookie set that has no session in it', async () => {
    read.mockReturnValue({
      cookies: [cookie('oai-did'), cookie('cf_clearance'), cookie('_cf_bm')],
      path: '/tmp/x'
    });
    const { session } = fakeSession();

    await expect(importSafariSessionNow(session, 'chatgpt.com')).resolves.toMatchObject({
      imported: 3,
      hasSession: false
    });
  });

  it('reports missing access, an empty store and a session-less store', async () => {
    const { session } = fakeSession();

    read.mockReturnValue({ cookies: [], error: 'denied' });
    await expect(importSafariSessionNow(session, 'chatgpt.com')).resolves.toMatchObject({ error: 'denied' });

    read.mockReturnValue({ cookies: [], error: 'missing' });
    await expect(importSafariSessionNow(session, 'chatgpt.com')).resolves.toMatchObject({ error: 'missing' });

    read.mockReturnValue({ cookies: [{ ...cookie('x'), domain: 'example.com' }], path: '/tmp/x' });
    await expect(importSafariSessionNow(session, 'chatgpt.com')).resolves.toMatchObject({ error: 'none' });
  });

  it('uses the provider rule to decide whether a Google session is a login', async () => {
    read.mockReturnValue({
      cookies: [
        { ...cookie('NID'), domain: 'google.com' },
        { ...cookie('__Secure-1PSID'), domain: 'google.com' }
      ],
      path: '/tmp/x'
    });
    const { session } = fakeSession();

    // Without the provider rule the ChatGPT pattern sees no session at all.
    await expect(importSafariSessionNow(session, 'gemini.google.com')).resolves.toMatchObject({
      matched: 2,
      hasSession: false
    });
    await expect(
      importSafariSessionNow(session, 'gemini.google.com', GOOGLE_PATTERN)
    ).resolves.toMatchObject({ matched: 2, hasSession: true });
  });
});

describe('readSafariGoogleSession', () => {
  beforeEach(() => {
    read.mockReset();
  });

  it('keeps every Google cookie, so extra accounts survive the copy', () => {
    read.mockReturnValue({
      cookies: [
        { ...cookie('SID'), domain: '.google.com' },
        { ...cookie('NID'), domain: '.google.com' },
        { ...cookie('session-token'), domain: 'chatgpt.com' }
      ],
      path: '/tmp/x'
    });

    const session = readSafariGoogleSession();
    expect(session.cookies.map((item) => item.name).sort()).toEqual(['NID', 'SID']);
    expect(session.session).toBeTruthy();
  });

  it('reports nothing when Safari has no Google session or the store is unreadable', () => {
    read.mockReturnValue({ cookies: [{ ...cookie('NID'), domain: '.google.com' }], path: '/tmp/x' });
    expect(readSafariGoogleSession()).toEqual({ cookies: [] });

    read.mockReturnValue({ cookies: [], error: 'denied' });
    expect(readSafariGoogleSession()).toEqual({ cookies: [] });
  });

  // Adding a second account to one Google login keeps the session cookie, so the
  // fingerprint must stay the same; signing in as somebody else changes it.
  it('fingerprints the login rather than the cookie list', () => {
    read.mockReturnValue({
      cookies: [{ ...cookie('SID', 'a'), domain: '.google.com' }],
      path: '/tmp/x'
    });
    const alone = readSafariGoogleSession().session;

    read.mockReturnValue({
      cookies: [
        { ...cookie('SID', 'a'), domain: '.google.com' },
        { ...cookie('NID'), domain: '.google.com' }
      ],
      path: '/tmp/x'
    });
    expect(readSafariGoogleSession().session).toBe(alone);

    read.mockReturnValue({
      cookies: [{ ...cookie('SID', 'b'), domain: '.google.com' }],
      path: '/tmp/x'
    });
    expect(readSafariGoogleSession().session).not.toBe(alone);
  });
});

describe('importSafariGoogleSession', () => {
  it('writes exactly the cookies it is given', async () => {
    const { session, writes } = fakeSession();

    await expect(
      importSafariGoogleSession(session, [{ ...cookie('SID'), domain: '.google.com' }])
    ).resolves.toBe(1);
    expect(writes.map((write) => write.name)).toEqual(['SID']);

    await expect(importSafariGoogleSession(session, [])).resolves.toBe(0);
    expect(writes).toHaveLength(1);
  });
});
