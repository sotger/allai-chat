import { describe, expect, it } from 'vitest';

import { HistoryIndex, tokenize } from './history-index';
import type { HistoryEntry } from './history';

function entry(id: string, over: Partial<HistoryEntry> = {}): HistoryEntry {
  return {
    id,
    tabId: 'tab',
    providerId: 'chatgpt',
    service: 'ChatGPT',
    url: `https://chatgpt.com/c/${id}`,
    title: `Chat ${id}`,
    text: '',
    capturedAt: 1,
    titleOnly: false,
    ...over
  };
}

describe('tokenize', () => {
  it('handles latin, cyrillic and digits', () => {
    expect(tokenize('OAuth 2.0 и Google-логин')).toEqual(['oauth', '2', '0', 'google', 'логин']);
  });
});

describe('HistoryIndex', () => {
  it('returns nothing for short queries', () => {
    const index = new HistoryIndex();
    index.add(entry('a', { text: 'hello world' }));
    expect(index.search('h')).toEqual([]);
    expect(index.search('   ')).toEqual([]);
  });

  it('finds body text and builds a snippet', () => {
    const index = new HistoryIndex();
    index.add(entry('a', {
      title: 'Random title',
      text: 'Много текста вокруг. Здесь обсуждается OAuth popup и window.opener. И ещё текст.'
    }));
    const [hit] = index.search('window.opener');
    expect(hit.title).toBe('Random title');
    expect(hit.snippet).toContain('window.opener');
  });

  it('ranks title matches above body matches', () => {
    const index = new HistoryIndex();
    index.add(entry('title', { title: 'Deploy notes', text: 'unrelated' }));
    index.add(entry('body', { title: 'Other', text: 'deploy notes appear once here' }));
    const hits = index.search('deploy');
    expect(hits[0].id).toBe('title');
  });

  it('is case-insensitive for cyrillic', () => {
    const index = new HistoryIndex();
    index.add(entry('a', { title: 'Поиск по истории', text: '' }));
    expect(index.search('ИСТОРИИ')[0]?.id).toBe('a');
  });

  it('matches phrases that the tokenizer splits', () => {
    const index = new HistoryIndex();
    index.add(entry('a', { title: 'Ctrl+Space launcher', text: '' }));
    expect(index.search('ctrl+space')).toHaveLength(1);
  });

  it('updates an existing document instead of duplicating it', () => {
    const index = new HistoryIndex();
    index.add(entry('a', { title: 'Old', text: 'alpha' }));
    index.add(entry('a', { title: 'New', text: 'beta' }));
    expect(index.size).toBe(1);
    expect(index.search('alpha')).toHaveLength(0);
    expect(index.search('beta')).toHaveLength(1);
    expect(index.search('new')[0]?.title).toBe('New');
  });

  it('ignores documents removed from the index', () => {
    const index = new HistoryIndex();
    index.add(entry('a', { text: 'temporary' }));
    index.remove('a');
    expect(index.size).toBe(0);
    expect(index.search('temporary')).toEqual([]);
  });

  it('respects the result limit and sorts by score', () => {
    const index = new HistoryIndex();
    for (let i = 0; i < 10; i += 1) {
      index.add(entry(`d${i}`, { title: `note ${i}`, text: 'shared keyword' }));
    }
    index.add(entry('best', { title: 'shared keyword', text: 'shared keyword' }));
    const hits = index.search('shared', 3);
    expect(hits).toHaveLength(3);
    expect(hits[0].id).toBe('best');
  });

  it('falls back to substring matching when tokens do not line up', () => {
    const index = new HistoryIndex();
    index.add(entry('a', { title: 'Отделение диалогов от шума', text: '' }));
    expect(index.search('диалогов от шума')).toHaveLength(1);
  });

  it('keeps title-only entries searchable', () => {
    const index = new HistoryIndex();
    index.add(entry('a', { title: 'Про Samba', text: '', titleOnly: true }));
    const [hit] = index.search('samba');
    expect(hit.titleOnly).toBe(true);
    expect(hit.snippet).toBe('');
  });
});
