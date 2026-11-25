import { describe, expect, it } from 'vitest';

import { normalizePreferences } from './preferences';

describe('normalizePreferences', () => {
  it('uses platform defaults for an empty file', () => {
    expect(normalizePreferences(undefined, '/home/user/Downloads')).toEqual({
      theme: 'system',
      downloadDirectory: '/home/user/Downloads',
      reuseGoogleSignIn: true,
      uiFontSize: 13,
      historyIndexEnabled: true,
      historyBackfillEnabled: false,
      syncFolder: '',
      syncEnabled: false,
      fullDiskAccessNoticeHidden: false
    });
  });

  it('keeps a valid saved configuration', () => {
    expect(normalizePreferences({
      theme: 'dark',
      downloadDirectory: '/tmp/files',
      reuseGoogleSignIn: false,
      uiFontSize: 15,
      historyIndexEnabled: false,
      historyBackfillEnabled: true,
      syncFolder: '/Users/me/iCloud/ALLAI-CHAT',
      syncEnabled: true
    }, '/home/user/Downloads')).toEqual({
      theme: 'dark',
      downloadDirectory: '/tmp/files',
      reuseGoogleSignIn: false,
      uiFontSize: 15,
      historyIndexEnabled: false,
      historyBackfillEnabled: true,
      syncFolder: '/Users/me/iCloud/ALLAI-CHAT',
      syncEnabled: true,
      fullDiskAccessNoticeHidden: false
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
      uiFontSize: 13,
      historyIndexEnabled: true,
      historyBackfillEnabled: false,
      syncFolder: '',
      syncEnabled: false,
      fullDiskAccessNoticeHidden: false
    });
  });

  it('remembers that the Full Disk Access warning was silenced', () => {
    expect(normalizePreferences({ fullDiskAccessNoticeHidden: true }, '/tmp').fullDiskAccessNoticeHidden).toBe(true);
    expect(normalizePreferences({ fullDiskAccessNoticeHidden: 'yes' as never }, '/tmp').fullDiskAccessNoticeHidden).toBe(false);
  });

  it('falls back for an unknown interface font size', () => {
    expect(normalizePreferences({ uiFontSize: 99 }, '/tmp/Downloads').uiFontSize).toBe(13);
  });
});
