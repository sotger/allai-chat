import { describe, expect, it } from 'vitest';

import type { ServiceTab } from '@shared/types';

import { toHistoryEntry } from './capture';

const tab: ServiceTab = {
  id: 't1',
  providerId: 'claude',
  label: 'Claude',
  url: 'https://claude.ai/',
  partition: 'persist:test',
  color: '#d97757',
  icon: 'C',
  createdAt: '2026-01-01T00:00:00.000Z'
};

const page = (url: string, text: string) => ({ url, title: 'Claude', text });

describe('toHistoryEntry', () => {
  it('keeps a real conversation', () => {
    const entry = toHistoryEntry(
      tab,
      page('https://claude.ai/chat/5bd21e7b-8052-4234-a3e7-e81f89310239', `Conversation ${'x'.repeat(40)}`)
    );
    expect(entry?.title).toBe('Claude');
    expect(entry?.titleOnly).toBe(false);
  });

  it('ignores list, library and account pages', () => {
    expect(toHistoryEntry(tab, page('https://claude.ai/chats', `Chats ${'x'.repeat(80)}`))).toBeUndefined();
    expect(toHistoryEntry(tab, page('https://www.perplexity.ai/library', `Library ${'x'.repeat(80)}`))).toBeUndefined();
    expect(toHistoryEntry(tab, page('https://grok.com/#subscribe', `Subscribe ${'x'.repeat(80)}`))).toBeUndefined();
  });

  it('ignores private-link and sign-in walls', () => {
    expect(toHistoryEntry(
      tab,
      page('https://grok.com/c/ff3a2219-58df-4601-9bda-b22eee0c7586', 'You need access. This is a private conversation link.')
    )).toBeUndefined();
    expect(toHistoryEntry(
      tab,
      page('https://chat.deepseek.com/sign_in', 'Please sign in to continue to view this conversation.')
    )).toBeUndefined();
  });
});
