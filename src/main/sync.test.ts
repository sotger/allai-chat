import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { HistoryEntry } from '@shared/history';
import type { SyncEntry } from '@shared/sync';
import type { ServiceTab } from '@shared/types';

import type { HistoryStore } from './history/store';
import { HistorySync } from './sync';

vi.mock('electron', () => ({
  app: {
    getPath: () => process.env.ALLAI_SYNC_TEST_USER_DATA ?? os.tmpdir(),
    getVersion: () => '1.8.1'
  }
}));

const directories: string[] = [];

function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  directories.push(dir);
  return dir;
}

afterEach(() => {
  delete process.env.ALLAI_SYNC_TEST_USER_DATA;
  for (const dir of directories.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tab(): ServiceTab {
  return {
    id: 'tab-1',
    providerId: 'chatgpt',
    label: 'ChatGPT',
    url: 'https://chatgpt.com/',
    partition: 'persist:service-tab-1',
    color: '#000000',
    icon: 'C',
    createdAt: new Date(0).toISOString()
  };
}

function syncEntry(over: Partial<SyncEntry> = {}): SyncEntry {
  return {
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

function syncFile(deviceId: string, entries: SyncEntry[]): string {
  return JSON.stringify({
    format: 'allai-history',
    version: 1,
    deviceId,
    deviceName: `Device ${deviceId}`,
    appVersion: '1.8.0',
    exportedAt: Date.now(),
    entries,
    tombstones: [],
    clearedAt: 0
  });
}

/** Minimal in-memory store: enough for HistorySync's merge path. */
function makeStore(): { store: HistoryStore; entries: Map<string, HistoryEntry> } {
  const entries = new Map<string, HistoryEntry>();
  const store = {
    load: async () => {},
    all: () => [...entries.values()],
    get: (id: string) => entries.get(id),
    upsert: (entry: HistoryEntry) => {
      entries.set(entry.id, entry);
      return entry;
    },
    isTombstoned: () => false,
    tombstonesForSync: () => [],
    getClearedAt: () => 0,
    applyRemoteClear: async () => 0,
    applyRemoteTombstones: async () => 0
  } as unknown as HistoryStore;
  return { store, entries };
}

function makeSync(folder: string): { sync: HistorySync; entries: Map<string, HistoryEntry> } {
  process.env.ALLAI_SYNC_TEST_USER_DATA = tempDir('allai-sync-userdata-');
  const { store, entries } = makeStore();
  const sync = new HistorySync({
    store,
    getTabs: () => [tab()],
    getFolder: () => folder,
    isEnabled: () => true,
    onStatus: () => {},
    onIndexChanged: () => {}
  });
  return { sync, entries };
}

describe('HistorySync unread reporting', () => {
  it('merges readable files and counts the ones it could not parse', async () => {
    const folder = tempDir('allai-sync-folder-');
    fs.writeFileSync(
      path.join(folder, 'allai-history-dev-b.json'),
      syncFile('dev-b', [syncEntry()])
    );
    // A partially uploaded / not yet downloaded file.
    fs.writeFileSync(path.join(folder, 'allai-history-dev-c.json'), '{"format":"allai-history",');

    const { sync, entries } = makeSync(folder);
    const status = await sync.syncNow();

    expect(status.lastError).toBeUndefined();
    expect(status.files).toBe(3); // this device + dev-b + dev-c
    expect(status.unread).toBe(1);
    expect(status.unreadFiles).toEqual(['allai-history-dev-c.json']);
    expect(status.summary).toBe('1 new, 1 file not read yet');
    expect(entries.size).toBe(1);
  });

  it('reports a file that disappeared or is unreadable without failing the pass', async () => {
    const folder = tempDir('allai-sync-folder-');
    const { sync } = makeSync(folder);
    // A directory with a sync-like name cannot be read as a file.
    fs.mkdirSync(path.join(folder, 'allai-history-broken.json'));

    const status = await sync.syncNow();

    expect(status.lastError).toBeUndefined();
    expect(status.unread).toBe(1);
    expect(status.unreadFiles).toEqual(['allai-history-broken.json']);
    expect(status.summary).toBe('1 file not read yet');
  });

  it('clears the unread count once the file is readable', async () => {
    const folder = tempDir('allai-sync-folder-');
    const file = path.join(folder, 'allai-history-dev-b.json');
    fs.writeFileSync(file, 'not json yet');
    const { sync } = makeSync(folder);

    expect((await sync.syncNow()).unread).toBe(1);
    fs.writeFileSync(file, syncFile('dev-b', [syncEntry()]));
    const status = await sync.syncNow();

    expect(status.unread).toBe(0);
    expect(status.unreadFiles).toEqual([]);
    expect(status.summary).toContain('1 new');
  });
});
