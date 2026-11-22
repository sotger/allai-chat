import { describe, expect, it } from 'vitest';

import {
  describeSyncMerge,
  isSyncFileName,
  parseSyncFile,
  syncFileName,
  syncKey,
  toSyncEntry,
  type HistorySyncFile,
  type SyncMergeResult
} from './sync';
import type { HistoryEntry } from './history';

function entry(over: Partial<HistoryEntry> = {}): HistoryEntry {
  return {
    id: 't1:abc',
    tabId: 't1',
    providerId: 'chatgpt',
    service: 'ChatGPT',
    url: 'https://chatgpt.com/c/6a47b398-2390-83eb',
    title: 'A chat',
    text: 'hello world',
    capturedAt: 1_700_000_000_000,
    titleOnly: false,
    ...over
  };
}

function file(): HistorySyncFile {
  return {
    format: 'allai-history',
    version: 1,
    deviceId: 'device-1',
    deviceName: 'Mac',
    appVersion: '1.8.0',
    exportedAt: 1_700_000_000_000,
    entries: [toSyncEntry(entry())],
    tombstones: [{ key: syncKey('chatgpt', 'https://chatgpt.com/c/dead-beef'), deletedAt: 12 }],
    clearedAt: 0
  };
}

describe('sync file', () => {
  it('round-trips a valid file', () => {
    const parsed = parseSyncFile(JSON.stringify(file()));
    expect(parsed?.entries).toHaveLength(1);
    expect(parsed?.entries[0]).toMatchObject({
      providerId: 'chatgpt',
      url: 'https://chatgpt.com/c/6a47b398-2390-83eb',
      service: 'ChatGPT',
      title: 'A chat',
      text: 'hello world'
    });
    expect(parsed?.tombstones).toHaveLength(1);
    expect(parsed?.deviceName).toBe('Mac');
    expect(parsed?.clearedAt).toBe(0);
  });

  it('defaults a missing clear marker to zero', () => {
    const raw = file() as Partial<HistorySyncFile>;
    delete raw.clearedAt;
    expect(parseSyncFile(JSON.stringify(raw))?.clearedAt).toBe(0);
  });

  it('rejects another format or version', () => {
    expect(parseSyncFile('{"format":"other","version":1}')).toBeUndefined();
    expect(parseSyncFile('{"format":"allai-history","version":2}')).toBeUndefined();
    expect(parseSyncFile('not json')).toBeUndefined();
  });

  it('drops invalid rows instead of failing the whole file', () => {
    const raw = {
      ...file(),
      entries: [
        { providerId: 'chatgpt', url: 'https://chatgpt.com/c/aaaa', title: 'ok', text: '', capturedAt: 1 },
        { providerId: 'nope', url: 'https://chatgpt.com/c/bbbb' },
        { providerId: 'claude', url: 'file:///etc/passwd' },
        null
      ]
    };
    const parsed = parseSyncFile(JSON.stringify(raw));
    expect(parsed?.entries).toHaveLength(1);
    expect(parsed?.entries[0].titleOnly).toBe(true);
  });

  it('keeps device names filesystem-safe', () => {
    expect(syncFileName('abc-123_XY')).toBe('allai-history-abc-123_XY.json');
    expect(syncFileName('a/b:c')).toBe('allai-history-abc.json');
    expect(isSyncFileName('allai-history-x.json')).toBe(true);
    expect(isSyncFileName('history.json')).toBe(false);
  });

  it('summarizes a merge', () => {
    const merge: SyncMergeResult = {
      imported: 3, upgraded: 1, tombstoned: 2, noTab: 4, unchanged: 9
    };
    expect(describeSyncMerge(merge)).toBe('3 new, 1 updated, 2 deleted elsewhere, 4 without a matching tab');
    expect(describeSyncMerge({ ...merge, imported: 0, upgraded: 0, tombstoned: 0, noTab: 0 }))
      .toBe('Already up to date');
  });

  it('never claims "up to date" while a file is unread', () => {
    const idle: SyncMergeResult = {
      imported: 0, upgraded: 0, tombstoned: 0, noTab: 0, unchanged: 9
    };
    expect(describeSyncMerge(idle, 1)).toBe('1 file not read yet');
    expect(describeSyncMerge(idle, 2)).toBe('2 files not read yet');
    expect(describeSyncMerge({ ...idle, imported: 3, noTab: 4 }, 1))
      .toBe('3 new, 1 file not read yet, 4 without a matching tab');
  });

  it('keys conversations by provider and canonical url', () => {
    expect(syncKey('chatgpt', 'https://chatgpt.com/c/x/?utm=1#top'))
      .toBe('chatgpt:https://chatgpt.com/c/x');
    expect(syncKey('chatgpt', 'https://chatgpt.com/c/x'))
      .not.toBe(syncKey('claude', 'https://chatgpt.com/c/x'));
  });
});
