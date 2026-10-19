import { describe, expect, it } from 'vitest';

import { normalizePreferences } from './preferences';

describe('normalizePreferences', () => {
  it('uses platform defaults for an empty file', () => {
    expect(normalizePreferences(undefined, '/home/user/Downloads')).toEqual({
      theme: 'system',
      downloadDirectory: '/home/user/Downloads',
      reuseGoogleSignIn: true
    });
  });

  it('keeps a valid saved configuration', () => {
    expect(normalizePreferences({
      theme: 'dark',
      downloadDirectory: '/tmp/files',
      reuseGoogleSignIn: false
    }, '/home/user/Downloads')).toEqual({
      theme: 'dark',
      downloadDirectory: '/tmp/files',
      reuseGoogleSignIn: false
    });
  });

  it('falls back for invalid themes and empty folders', () => {
    expect(normalizePreferences({
      theme: 'sepia' as never,
      downloadDirectory: '   ',
      reuseGoogleSignIn: undefined
    }, '/home/user/Downloads')).toEqual({
      theme: 'system',
      downloadDirectory: '/home/user/Downloads',
      reuseGoogleSignIn: true
    });
  });
});
