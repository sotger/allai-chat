import { describe, expect, it } from 'vitest';

import { normalizePreferences } from './preferences';

describe('normalizePreferences', () => {
  it('uses platform defaults for an empty file', () => {
    expect(normalizePreferences(undefined, '/home/user/Downloads')).toEqual({
      theme: 'system',
      downloadDirectory: '/home/user/Downloads',
      reuseGoogleSignIn: true,
      uiFontSize: 13
    });
  });

  it('keeps a valid saved configuration', () => {
    expect(normalizePreferences({
      theme: 'dark',
      downloadDirectory: '/tmp/files',
      reuseGoogleSignIn: false,
      uiFontSize: 15
    }, '/home/user/Downloads')).toEqual({
      theme: 'dark',
      downloadDirectory: '/tmp/files',
      reuseGoogleSignIn: false,
      uiFontSize: 15
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
      reuseGoogleSignIn: true,
      uiFontSize: 13
    });
  });

  it('falls back for an unknown interface font size', () => {
    expect(normalizePreferences({ uiFontSize: 99 }, '/tmp/Downloads').uiFontSize).toBe(13);
  });
});
