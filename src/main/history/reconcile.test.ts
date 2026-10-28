import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { WebContents } from 'electron';
import { afterEach, describe, expect, it } from 'vitest';

import type { ServiceTab } from '@shared/types';

import type { HistoryBackfill } from './backfill';
import { HistoryReconciler } from './reconcile';
import type { HistoryStore } from './store';

const directories: string[] = [];

function tempStatePath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'allai-reconcile-'));
  directories.push(dir);
  return path.join(dir, 'reconcile.json');
}

function tab(): ServiceTab {
  return {
    id: 'tab-1',
    providerId: 'claude',
    label: 'Claude',
    url: 'https://claude.ai/chat/3ba6f729-0fa5-48b2-a519-e7005ca75b2f',
    partition: 'persist:service-tab-1',
    color: '#fff',
    icon: 'C',
    createdAt: new Date(0).toISOString()
  };
}

function contents(links: Array<{ url: string; title: string }>): WebContents {
  return {
    isDestroyed: () => false,
    executeJavaScript: async () => links
  } as unknown as WebContents;
}

function makeReconciler(options: {
  statePath: string;
  enabled?: boolean;
  running?: boolean;
  storeGet?: () => undefined | { titleOnly: boolean };
  discovered?: Array<{ url: string; title: string }>;
  calls?: Array<{ tabId: string; options: unknown }>;
  contentsOverride?: WebContents;
}): HistoryReconciler {
  const store = { get: options.storeGet ?? (() => undefined) } as unknown as HistoryStore;
  const backfill = {
    isRunning: () => options.running ?? false,
    start: async (tabId: string, runOptions: unknown) => {
      options.calls?.push({ tabId, options: runOptions });
      return { running: false, done: 0, total: 0 };
    }
  } as unknown as HistoryBackfill;

  return new HistoryReconciler({
    store,
    backfill,
    getTabs: () => [tab()],
    getContents: () => options.contentsOverride ?? contents(options.discovered ?? []),
    isEnabled: () => options.enabled ?? true,
    statePath: options.statePath
  });
}

afterEach(() => {
  for (const dir of directories.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('HistoryReconciler', () => {
  it('queues only chats without stored text and caps the batch', async () => {
    const statePath = tempStatePath();
    const calls: Array<{ tabId: string; options: unknown }> = [];
    const reconciler = makeReconciler({
      statePath,
      calls,
      discovered: [
        { url: 'https://claude.ai/chat/3ba6f729-0fa5-48b2-a519-e7005ca75b2f', title: 'First' },
        { url: 'https://claude.ai/settings', title: 'Settings' }
      ]
    });

    await reconciler.check();

    expect(calls).toHaveLength(1);
    expect(calls[0].tabId).toBe('tab-1');
    expect(calls[0].options).toMatchObject({ reason: 'auto', limit: 1 });
    expect(JSON.parse(fs.readFileSync(statePath, 'utf-8'))['tab-1']).toBeGreaterThan(0);
  });

  it('does nothing when a recent check was recorded', async () => {
    const statePath = tempStatePath();
    fs.writeFileSync(statePath, JSON.stringify({ 'tab-1': Date.now() }), 'utf-8');
    const calls: Array<{ tabId: string; options: unknown }> = [];
    const reconciler = makeReconciler({
      statePath,
      calls,
      discovered: [{ url: 'https://claude.ai/chat/3ba6f729-0fa5-48b2-a519-e7005ca75b2f', title: 'First' }]
    });
    reconciler.start();
    reconciler.stop();

    await reconciler.check();

    expect(calls).toHaveLength(0);
  });

  it('does nothing when background indexing is disabled', async () => {
    const calls: Array<{ tabId: string; options: unknown }> = [];
    const reconciler = makeReconciler({ statePath: tempStatePath(), calls, enabled: false });

    await reconciler.check();

    expect(calls).toHaveLength(0);
  });

  it('does not start while another run is active', async () => {
    const calls: Array<{ tabId: string; options: unknown }> = [];
    const reconciler = makeReconciler({
      statePath: tempStatePath(),
      calls,
      running: true,
      discovered: [{ url: 'https://claude.ai/chat/3ba6f729-0fa5-48b2-a519-e7005ca75b2f', title: 'First' }]
    });

    await reconciler.check();

    expect(calls).toHaveLength(0);
  });

  it('skips chats that already have text', async () => {
    const calls: Array<{ tabId: string; options: unknown }> = [];
    const reconciler = makeReconciler({
      statePath: tempStatePath(),
      calls,
      storeGet: () => ({ titleOnly: false }),
      discovered: [{ url: 'https://claude.ai/chat/3ba6f729-0fa5-48b2-a519-e7005ca75b2f', title: 'First' }]
    });

    await reconciler.check();

    expect(calls).toHaveLength(0);
  });
});
