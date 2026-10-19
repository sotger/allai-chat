import { describe, expect, it } from 'vitest';

import { isGoogleAuthCookieName } from './google-auth';

describe('isGoogleAuthCookieName', () => {
  it('recognises Google session cookies', () => {
    expect(isGoogleAuthCookieName('SID')).toBe(true);
    expect(isGoogleAuthCookieName('__Secure-1PSID')).toBe(true);
    expect(isGoogleAuthCookieName('__Secure-3PSIDTS')).toBe(true);
  });

  it('ignores preference and analytics cookies', () => {
    expect(isGoogleAuthCookieName('NID')).toBe(false);
    expect(isGoogleAuthCookieName('CONSENT')).toBe(false);
    expect(isGoogleAuthCookieName('_ga')).toBe(false);
  });
});
