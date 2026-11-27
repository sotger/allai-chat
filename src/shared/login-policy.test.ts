import { describe, expect, it } from 'vitest';

import {
  chooseStrategy,
  classifyProvider,
  cookiesSatisfiedBy,
  isProviderErrorUrl,
  isSignInPath,
  looksLikeProviderError,
  serviceEntryUrl
} from './login-policy';

describe('classifyProvider', () => {
  it('maps the known sign-in hosts', () => {
    expect(classifyProvider('accounts.google.com')).toBe('google');
    expect(classifyProvider('login.microsoftonline.com')).toBe('microsoft');
    expect(classifyProvider('appleid.apple.com')).toBe('apple');
    expect(classifyProvider('github.com')).toBe('github');
    expect(classifyProvider('auth.example.com')).toBe('other');
  });

  it('treats Clerk subdomains as Clerk', () => {
    expect(classifyProvider('clerk.accounts.dev')).toBe('clerk');
    expect(classifyProvider('auth.suno.com')).toBe('other');
  });
});

describe('chooseStrategy', () => {
  const base = {
    provider: 'google' as const,
    sharingEnabled: true,
    browserGoogle: 'signed-in' as const,
    vaultHasGoogle: true,
    tabHasGoogle: false
  };

  it('answers Google in the tab while the browser holds the login', () => {
    expect(chooseStrategy(base)).toEqual({ strategy: 'in-tab', reason: 'browser-signed-in' });
  });

  it('hands a signed-out browser over to Safari even when the vault has a session', () => {
    expect(chooseStrategy({ ...base, browserGoogle: 'signed-out' }))
      .toEqual({ strategy: 'browser', reason: 'browser-signed-out' });
  });

  it('keeps the vault fallback when the browser store is unreadable', () => {
    expect(chooseStrategy({ ...base, browserGoogle: 'unknown' }))
      .toEqual({ strategy: 'in-tab', reason: 'vault-fallback' });
    expect(chooseStrategy({ ...base, browserGoogle: 'unknown', vaultHasGoogle: false, tabHasGoogle: false }))
      .toEqual({ strategy: 'browser', reason: 'no-google-session' });
  });

  it('never answers another provider in the tab', () => {
    expect(chooseStrategy({ ...base, provider: 'apple' }))
      .toEqual({ strategy: 'browser', reason: 'provider-apple' });
    expect(chooseStrategy({ ...base, provider: 'microsoft' }))
      .toEqual({ strategy: 'browser', reason: 'provider-microsoft' });
  });

  it('respects a tab that opted out of shared sign-in', () => {
    expect(chooseStrategy({ ...base, sharingEnabled: false }))
      .toEqual({ strategy: 'browser', reason: 'sharing-off' });
  });
});

describe('sign-in URLs', () => {
  it('recognises the pages that ask to sign in', () => {
    expect(isSignInPath('https://www.seedance.ai/signin?from=%2F')).toBe(true);
    expect(isSignInPath('https://chatgpt.com/auth/login')).toBe(true);
    expect(isSignInPath('https://claude.ai/login')).toBe(true);
    expect(isSignInPath('https://www.service.ai/')).toBe(false);
    expect(isSignInPath('https://www.perplexity.ai/session/48042b45')).toBe(false);
  });

  it('lands on the service origin after a sign-in URL', () => {
    expect(serviceEntryUrl('https://www.seedance.ai/signin?from=%2F')).toBe('https://www.seedance.ai/');
    expect(serviceEntryUrl('https://chatgpt.com/c/abc')).toBe('https://chatgpt.com/c/abc');
    expect(serviceEntryUrl('not a url')).toBe('not a url');
  });
});

describe('provider errors', () => {
  it('spots error parameters and provider error endpoints', () => {
    expect(isProviderErrorUrl('https://accounts.google.com/signin/oauth/error?authError=1')).toBe(true);
    expect(isProviderErrorUrl('https://www.seedance.ai/auth/callback?error=access_denied')).toBe(true);
    expect(isProviderErrorUrl('https://accounts.google.com/o/oauth2/v2/auth?client_id=x')).toBe(false);
  });

  it('spots a 200 error page by its title', () => {
    expect(looksLikeProviderError('Error 400 (Bad Request)!!1')).toBe(true);
    expect(looksLikeProviderError('Something went wrong')).toBe(true);
    expect(looksLikeProviderError('Sign in – Google Accounts')).toBe(false);
    expect(looksLikeProviderError(undefined)).toBe(false);
  });
});

describe('cookiesSatisfiedBy', () => {
  const cookie = (name: string, value = 'v', expirationDate = 1_800_000_000) => ({
    domain: '.google.com', path: '/', name, value, expirationDate
  });

  it('accepts a superset that already holds the same values', () => {
    expect(cookiesSatisfiedBy([cookie('SID')], [cookie('SID'), cookie('NID')])).toBe(true);
  });

  it('rejects a changed value, a changed expiry or a missing cookie', () => {
    expect(cookiesSatisfiedBy([cookie('SID', 'new')], [cookie('SID', 'old')])).toBe(false);
    expect(cookiesSatisfiedBy([cookie('SID', 'v', 10)], [cookie('SID', 'v', 20)])).toBe(false);
    expect(cookiesSatisfiedBy([cookie('SID')], [cookie('NID')])).toBe(false);
  });
});
