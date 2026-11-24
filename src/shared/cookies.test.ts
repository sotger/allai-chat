import { describe, expect, it } from 'vitest';

import { cookieMatchesHost, filterCookiesForHost, parseCookieText } from './cookies';

const NETSCAPE = [
  '# Netscape HTTP Cookie File',
  '.chatgpt.com\tTRUE\t/\tTRUE\t1798765432\t__Secure-authjs.session-token\teyJhbGci',
  '#HttpOnly_.chatgpt.com\tTRUE\t/\tTRUE\t1798765400\toai-did\tabc-123',
  'chatgpt.com\tFALSE\t/c/\tFALSE\t0\t_cf_bm\tshort',
  'example.com\tFALSE\t/\tFALSE\t1999999999\tother\t1'
].join('\n');

describe('parseCookieText: Netscape export', () => {
  it('reads domain, flags, expiry and the HttpOnly marker', () => {
    const cookies = parseCookieText(NETSCAPE);
    const session = cookies.find((cookie) => cookie.name === '__Secure-authjs.session-token');
    expect(session).toMatchObject({
      domain: 'chatgpt.com',
      includeSubdomains: true,
      path: '/',
      secure: true,
      httpOnly: false,
      expirationDate: 1798765432
    });

    const device = cookies.find((cookie) => cookie.name === 'oai-did');
    expect(device?.httpOnly).toBe(true);
    expect(device?.value).toBe('abc-123');
  });

  it('keeps session cookies session-scoped', () => {
    const cookies = parseCookieText(NETSCAPE);
    expect(cookies.find((cookie) => cookie.name === '_cf_bm')?.expirationDate).toBeUndefined();
  });

  it('drops comments, blank lines and unparsable rows', () => {
    const cookies = parseCookieText(`${NETSCAPE}\n\nnot a cookie\n# just a comment`);
    expect(cookies.map((cookie) => cookie.name).sort()).toEqual([
      '__Secure-authjs.session-token',
      '_cf_bm',
      'oai-did',
      'other'
    ]);
  });

  it('deduplicates by domain, path and name with the last value winning', () => {
    const cookies = parseCookieText([
      '.chatgpt.com\tTRUE\t/\tTRUE\t0\tk\tfirst',
      '.chatgpt.com\tTRUE\t/\tTRUE\t0\tk\tsecond'
    ].join('\n'));
    expect(cookies).toHaveLength(1);
    expect(cookies[0].value).toBe('second');
  });
});

describe('parseCookieText: Cookie header', () => {
  it('expands a header into cookies for the given host', () => {
    const cookies = parseCookieText('Cookie: a=1; b=two=2; broken', 'chatgpt.com');
    expect(cookies.map((cookie) => [cookie.name, cookie.value])).toEqual([
      ['a', '1'],
      ['b', 'two=2']
    ]);
    expect(cookies.every((cookie) => cookie.domain === 'chatgpt.com' && cookie.secure)).toBe(true);
  });

  it('cannot place a header without a host', () => {
    expect(parseCookieText('a=1; b=2')).toEqual([]);
  });
});

describe('cookieMatchesHost', () => {
  it('matches the host itself, its subdomains and its parent domain', () => {
    expect(cookieMatchesHost('.chatgpt.com', 'chatgpt.com')).toBe(true);
    expect(cookieMatchesHost('chatgpt.com', 'chatgpt.com')).toBe(true);
    expect(cookieMatchesHost('.chatgpt.com', 'auth.chatgpt.com')).toBe(true);
    expect(cookieMatchesHost('.openai.com', 'auth.openai.com')).toBe(true);
    expect(cookieMatchesHost('auth.openai.com', 'openai.com')).toBe(true);
  });

  it('does not match unrelated hosts or lookalike domains', () => {
    expect(cookieMatchesHost('example.com', 'chatgpt.com')).toBe(false);
    expect(cookieMatchesHost('.chatgpt.com', 'notchatgpt.com')).toBe(false);
    expect(cookieMatchesHost('.chatgpt.com', 'chatgpt.com.evil.test')).toBe(false);
    expect(cookieMatchesHost('', 'chatgpt.com')).toBe(false);
  });
});

describe('filterCookiesForHost', () => {
  it('keeps only cookies that belong to the tab service', () => {
    const kept = filterCookiesForHost(parseCookieText(NETSCAPE), 'chatgpt.com');
    expect(kept.map((cookie) => cookie.name).sort()).toEqual([
      '__Secure-authjs.session-token',
      '_cf_bm',
      'oai-did'
    ]);
  });
});
