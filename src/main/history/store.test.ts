import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import type { HistoryEntry } from '@shared/history';

import { HistoryStore } from './store';

const directories: string[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'allai-store-'));
  directories.push(dir);
  return dir;
}

function entry(id: string, text: string, over: Partial<HistoryEntry> = {}): HistoryEntry {
  return {
    id,
    tabId: 't1',
    providerId: 'chatgpt',
    service: 'ChatGPT',
    url: `https://chatgpt.com/c/${id}`,
    title: `Chat ${id}`,
    text,
    capturedAt: 1,
    titleOnly: text.length === 0,
    ...over
  };
}

function lines(dir: string): string[] {
  const file = path.join(dir, 'history', 'entries.jsonl');
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf-8').trim().split('\n').filter(Boolean);
}

afterEach(() => {
  for (const dir of directories.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('HistoryStore', () => {
  it('does not append an identical capture twice', async () => {
    const dir = tempDir();
    const store = new HistoryStore(dir);
    await store.load();

    store.upsert(entry('a', 'same text'));
    store.flushSync();
    store.upsert(entry('a', 'same text'));
    store.flushSync();

    expect(lines(dir)).toHaveLength(1);
  });

  it('keeps the longer text when a shorter render arrives', async () => {
    const dir = tempDir();
    const store = new HistoryStore(dir);
    await store.load();

    store.upsert(entry('a', 'a long and complete answer'));
    store.upsert(entry('a', 'short'));
    store.flushSync();

    expect(store.get('a')?.text).toBe('a long and complete answer');
  });

  it('rebuilds the index from disk', async () => {
    const dir = tempDir();
    const first = new HistoryStore(dir);
    await first.load();
    first.upsert(entry('a', 'alpha beta'));
    first.flushSync();

    const second = new HistoryStore(dir);
    await second.load();

    expect(second.stats().entries).toBe(1);
    expect(second.search('beta')[0]?.id).toBe('a');
  });

  it('drops only the conversations of a removed tab', async () => {
    const dir = tempDir();
    const store = new HistoryStore(dir);
    await store.load();

    store.upsert(entry('a', 'alpha', { tabId: 't1' }));
    store.upsert(entry('b', 'beta', { tabId: 't2' }));
    store.flushSync();

    await store.removeTab('t1');

    expect(store.stats().entries).toBe(1);
    expect(store.search('alpha')).toHaveLength(0);
    expect(store.search('beta')).toHaveLength(1);
    expect(lines(dir)).toHaveLength(1);

    const reloaded = new HistoryStore(dir);
    await reloaded.load();
    expect(reloaded.stats().entries).toBe(1);
  });

  it('clears everything', async () => {
    const dir = tempDir();
    const store = new HistoryStore(dir);
    await store.load();
    store.upsert(entry('a', 'alpha'));
    store.flushSync();

    await store.clear();

    expect(store.stats().entries).toBe(0);
    expect(lines(dir)).toHaveLength(0);
  });
});
