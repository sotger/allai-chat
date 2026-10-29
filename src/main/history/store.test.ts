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

  it('tracks conversations that still have no text', async () => {
    const dir = tempDir();
    const store = new HistoryStore(dir);
    await store.load();

    store.upsert(entry('a', 'full text'));
    store.upsert(entry('b', '', { tabId: 't1' }));
    store.upsert(entry('c', '', { tabId: 't2' }));

    expect(store.unindexed().map((item) => item.id)).toEqual(['b', 'c']);
    expect(store.unindexed('t1').map((item) => item.id)).toEqual(['b']);
    expect(store.stats().withoutText).toBe(2);
  });

  it('forgets a row permanently with a tombstone', async () => {
    const dir = tempDir();
    const store = new HistoryStore(dir);
    await store.load();
    store.upsert(entry('a', 'keep'));
    store.upsert(entry('b', ''));
    store.flushSync();

    store.removeById('b');
    store.flushSync();

    expect(store.get('b')).toBeUndefined();
    expect(store.stats().entries).toBe(1);

    const reloaded = new HistoryStore(dir);
    await reloaded.load();
    expect(reloaded.get('b')).toBeUndefined();
    expect(reloaded.unindexed()).toHaveLength(0);
  });

  it('drops a queued row when the same chat is already indexed under another url', async () => {
    const dir = tempDir();
    const first = new HistoryStore(dir);
    await first.load();
    first.upsert(entry('indexed', 'full text', {
      url: 'https://chatgpt.com/g/g-p-6a3875dab9b08191bdf5915822205007-igra-everspace-2/c/6a47b398-2390-83eb'
    }));
    first.upsert(entry('queued', '', {
      url: 'https://chatgpt.com/g/g-p-6a3875dab9b08191bdf5915822205007/c/6a47b398-2390-83eb'
    }));
    first.flushSync();

    const second = new HistoryStore(dir);
    await second.load();

    expect(second.stats()).toMatchObject({ entries: 1, withText: 1, withoutText: 0 });
    expect(second.unindexed()).toHaveLength(0);
    expect(lines(dir)).toHaveLength(1);
  });

  it('keeps one queued row when a chat has several url variants', async () => {
    const dir = tempDir();
    const first = new HistoryStore(dir);
    await first.load();
    first.upsert(entry('short', '', {
      title: 'Queued',
      url: 'https://chatgpt.com/g/g-p-6a3875dab9b08191bdf5915822205007/c/6a47b398-2390-83eb'
    }));
    first.upsert(entry('slug', '', {
      title: 'Queued conversation',
      url: 'https://chatgpt.com/g/g-p-6a3875dab9b08191bdf5915822205007-igra-everspace-2/c/6a47b398-2390-83eb'
    }));
    first.flushSync();

    const second = new HistoryStore(dir);
    await second.load();

    const queued = second.unindexed();
    expect(queued).toHaveLength(1);
    expect(queued[0].title).toBe('Queued conversation');
  });

  it('notifies the panel when a row changes', async () => {
    const dir = tempDir();
    const store = new HistoryStore(dir);
    await store.load();

    let changes = 0;
    store.setOnChange(() => { changes += 1; });

    store.upsert(entry('a', ''));
    store.upsert(entry('a', ''));
    store.upsert(entry('a', 'text'));
    store.removeById('a');

    expect(changes).toBe(3);
  });

  it('drops utility pages and access walls on load', async () => {
    const dir = tempDir();
    const first = new HistoryStore(dir);
    await first.load();
    first.upsert(entry('chats', 'a long list of chats', {
      url: 'https://claude.ai/chats',
      title: 'Claude'
    }));
    first.upsert(entry('subscribe', 'One subscription. Access to everything.', {
      url: 'https://grok.com/#subscribe',
      title: 'Grok'
    }));
    first.upsert(entry('wall', 'You need access. This is a private conversation link.', {
      url: 'https://grok.com/c/ff3a2219-58df-4601-9bda-b22eee0c7586'
    }));
    first.upsert(entry('real', `real conversation ${'x'.repeat(60)}`, {
      url: 'https://claude.ai/chat/5bd21e7b-8052-4234-a3e7-e81f89310239'
    }));
    first.flushSync();

    const second = new HistoryStore(dir);
    await second.load();

    expect(second.stats().entries).toBe(1);
    expect(second.get('real')).toBeDefined();
    expect(lines(dir)).toHaveLength(1);
  });

  it('replaces a navigation label with the service name on load', async () => {
    const dir = tempDir();
    const first = new HistoryStore(dir);
    await first.load();
    first.upsert(entry('a', '', { title: 'Skip to main content' }));
    first.flushSync();

    const second = new HistoryStore(dir);
    await second.load();
    expect(second.get('a')?.title).toBe('ChatGPT');
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
