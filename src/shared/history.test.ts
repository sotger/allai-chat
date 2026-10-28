import { describe, expect, it } from 'vitest';

import {
  canonicalHistoryUrl,
  historyId,
  formatDuration,
  historyStats,
  isIndexableUrl,
  looksLikeChatUrl,
  mergeHistoryEntry,
  normalizeText,
  type HistoryEntry
} from './history';

function entry(over: Partial<HistoryEntry> = {}): HistoryEntry {
  return {
    id: 't1:abc',
    tabId: 't1',
    providerId: 'chatgpt',
    service: 'ChatGPT',
    url: 'https://chatgpt.com/c/6ae1d213-e6b4-83ed-b524-585289c01f75',
    title: 'Перевод письма',
    text: 'Текст беседы',
    capturedAt: 1,
    titleOnly: false,
    ...over
  };
}

describe('normalizeText', () => {
  it('collapses whitespace and trims', () => {
    expect(normalizeText('  a\n\n b\t c ')).toBe('a b c');
  });
});

describe('canonicalHistoryUrl', () => {
  it('drops the hash, trailing slash and tracking parameters', () => {
    expect(canonicalHistoryUrl('https://Grok.com/c/abc/?rid=123#top'))
      .toBe('https://grok.com/c/abc');
  });

  it('keeps a search query when present', () => {
    expect(canonicalHistoryUrl('https://x.test/search?q=hello&source=nav'))
      .toBe('https://x.test/search?q=hello');
  });

  it('produces the same id for equivalent urls', () => {
    const a = historyId('tab', 'https://chatgpt.com/c/abc/');
    const b = historyId('tab', 'https://chatgpt.com/c/abc#message-1');
    expect(a).toBe(b);
  });

  it('separates tabs', () => {
    expect(historyId('one', 'https://x.test/c/abc')).not.toBe(historyId('two', 'https://x.test/c/abc'));
  });
});

describe('url filters', () => {
  it('accepts chat urls and rejects utility pages', () => {
    expect(looksLikeChatUrl('https://chatgpt.com/c/6ae1d213-e6b4-83ed-b524-585289c01f75')).toBe(true);
    expect(looksLikeChatUrl('https://gemini.google.com/app/4220dbf06c49cd4c')).toBe(true);
    expect(looksLikeChatUrl('https://chat.deepseek.com/a/chat/s/a1cdda0a-2f36-499e-a1e8-f038bfb2da92')).toBe(true);
    expect(looksLikeChatUrl('https://chatgpt.com/')).toBe(false);
    expect(looksLikeChatUrl('https://chatgpt.com/pricing')).toBe(false);
  });

  it('never indexes auth providers', () => {
    expect(isIndexableUrl('https://accounts.google.com/o/oauth2/v2/auth')).toBe(false);
    expect(isIndexableUrl('https://chatgpt.com/c/abc')).toBe(true);
    expect(isIndexableUrl('file:///tmp/secret')).toBe(false);
  });
});

describe('mergeHistoryEntry', () => {
  it('upgrades a title-only row with captured text', () => {
    const merged = mergeHistoryEntry(entry({ text: '', titleOnly: true }), entry({ text: 'Полный текст' }));
    expect(merged.text).toBe('Полный текст');
    expect(merged.titleOnly).toBe(false);
  });

  it('keeps the longer text when a partial render arrives', () => {
    const merged = mergeHistoryEntry(entry({ text: 'длинный полный ответ' }), entry({ text: 'корот' }));
    expect(merged.text).toBe('длинный полный ответ');
  });

  it('takes a better title but does not lose text', () => {
    const merged = mergeHistoryEntry(entry({ text: 'тело', title: 'Old' }), entry({ text: '', title: 'New chat', titleOnly: true }));
    expect(merged.title).toBe('New chat');
    expect(merged.text).toBe('тело');
    expect(merged.titleOnly).toBe(false);
  });
});

describe('historyStats', () => {
  it('counts entries, text and services', () => {
    const stats = historyStats([
      entry({ id: 'a', text: 'abc' }),
      entry({ id: 'b', text: '', titleOnly: true }),
      entry({ id: 'c', tabId: 't2', text: 'de' })
    ]);
    expect(stats).toMatchObject({ entries: 3, withText: 2, characters: 5, services: 2 });
  });
});

describe('formatDuration', () => {
  it('formats minutes and seconds', () => {
    expect(formatDuration(0)).toBe('0:00');
    expect(formatDuration(45_000)).toBe('0:45');
    expect(formatDuration(7 * 60_000 + 20_000)).toBe('7:20');
  });

  it('adds hours for long runs', () => {
    expect(formatDuration(3_720_000)).toBe('1:02:00');
  });
});
