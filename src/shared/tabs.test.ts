import { describe, expect, it } from 'vitest';

import { createServiceTab, normalizeServiceUrl } from './tabs';

describe('createServiceTab', () => {
  it('creates a tab from a known provider', () => {
    const tab = createServiceTab({
      id: 'tab-1',
      providerId: 'gemini',
      existingCount: 0,
      now: new Date('2026-01-01T00:00:00Z')
    });

    expect(tab).toMatchObject({
      id: 'tab-1',
      providerId: 'gemini',
      label: 'Gemini',
      url: 'https://gemini.google.com/app',
      partition: 'persist:service-tab-1',
      color: '#4ecdc4',
      icon: 'Ge',
      createdAt: '2026-01-01T00:00:00.000Z'
    });
  });

  it('numbers extra tabs of the same provider', () => {
    const tab = createServiceTab({ id: 'tab-2', providerId: 'chatgpt', existingCount: 1 });
    expect(tab.label).toBe('ChatGPT 2');
  });

  it('keeps an explicit label and normalizes the custom URL', () => {
    const tab = createServiceTab({
      id: 'tab-3',
      providerId: 'custom',
      customUrl: 'example.com/chat',
      label: 'Work assistant',
      existingCount: 0
    });

    expect(tab.label).toBe('Work assistant');
    expect(tab.url).toBe('https://example.com/chat');
  });

  it('gives every tab a unique partition', () => {
    const first = createServiceTab({ id: 'a', providerId: 'claude', existingCount: 0 });
    const second = createServiceTab({ id: 'b', providerId: 'claude', existingCount: 1 });
    expect(first.partition).not.toBe(second.partition);
  });

  it('rejects a custom tab without a URL', () => {
    expect(() => createServiceTab({ id: 'tab-4', providerId: 'custom', existingCount: 0 }))
      .toThrow(/URL is required/);
  });
});

describe('normalizeServiceUrl', () => {
  it('adds https to a bare host', () => {
    expect(normalizeServiceUrl('chat.example.com')).toBe('https://chat.example.com');
  });

  it('keeps an explicit scheme', () => {
    expect(normalizeServiceUrl('http://localhost:3000')).toBe('http://localhost:3000');
  });

  it('trims whitespace and keeps empty input empty', () => {
    expect(normalizeServiceUrl('  https://a.b  ')).toBe('https://a.b');
    expect(normalizeServiceUrl('   ')).toBe('');
  });
});
