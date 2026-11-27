import { describe, expect, it } from 'vitest';

import { IN_TAB_TTL_MS, LoginFlowController, type LoginFlowHooks } from './login-flow';

function setup(overrides: Partial<LoginFlowHooks> = {}): {
  flow: LoginFlowController;
  calls: string[];
  advance: (ms: number) => void;
} {
  const calls: string[] = [];
  let time = 1_000_000;
  let id = 0;
  const hooks: LoginFlowHooks = {
    now: () => time,
    newId: () => `flow-${++id}`,
    log: (line) => calls.push(`log ${line}`),
    sharingEnabled: () => true,
    browserGoogle: () => 'signed-in',
    vaultHasGoogle: async () => true,
    tabHasGoogle: async () => false,
    copyBrowserGoogle: async () => 19,
    copyVaultGoogle: async () => 19,
    reloadProvider: (tabId) => calls.push(`reload ${tabId}`),
    reloadTab: (tabId) => calls.push(`reload ${tabId}`),
    navigateTab: (tabId, url) => calls.push(`navigate ${tabId} ${url}`),
    openBrowser: (tabId, trigger) => calls.push(`browser ${tabId} ${trigger}`),
    notify: (tabId, message) => calls.push(`notify ${tabId} ${message}`),
    entryUrl: () => 'https://service.example/',
    isAuthUrl: (url) => url.includes('accounts.google.com') || url.includes('appleid'),
    ...overrides
  };
  return {
    flow: new LoginFlowController(hooks),
    calls,
    advance: (ms: number) => { time += ms; }
  };
}

describe('LoginFlowController', () => {
  it('hands every non-Google provider to Safari', async () => {
    const { flow, calls } = setup();
    await flow.begin('t', 'appleid.apple.com', 'passkey');

    expect(calls).toContain('browser t passkey');
    expect(flow.get('t')?.stage).toBe('browser');
    expect(calls.some((line) => line.includes('reason=provider-apple'))).toBe(true);
  });

  it('answers Google in the tab with the live browser session', async () => {
    const { flow, calls } = setup();
    await flow.begin('t', 'accounts.google.com', 'navigation');

    expect(calls).toContain('reload t');
    expect(calls.some((line) => line.includes('stage=in-tab copied=19'))).toBe(true);
    expect(flow.get('t')?.stage).toBe('in-tab');
  });

  it('does not reload when the tab already holds that cookie set', async () => {
    // The second click in the same tab must not replay the OAuth page: that is
    // what produced Google's 400.
    const { flow, calls } = setup({
      copyBrowserGoogle: async () => 0,
      tabHasGoogle: async () => true
    });
    await flow.begin('t', 'accounts.google.com', 'navigation');

    expect(calls).not.toContain('reload t');
    expect(calls.some((line) => line.includes('tab already current'))).toBe(true);
    expect(flow.get('t')?.stage).toBe('in-tab');
  });

  it('hands over to Safari when the browser is signed out of Google', async () => {
    const { flow, calls } = setup({ browserGoogle: () => 'signed-out' });
    await flow.begin('t', 'accounts.google.com', 'navigation');

    expect(calls).toContain('browser t navigation');
    expect(calls.some((line) => line.includes('reason=browser-signed-out'))).toBe(true);
    expect(flow.get('t')?.stage).toBe('browser');
  });

  it('always sends a popup-based provider login to Safari', async () => {
    // The tab-level cookie copy cannot finish a popup round trip.
    const { flow, calls } = setup();
    await flow.begin('t', 'accounts.google.com', 'popup');

    expect(calls).toContain('browser t popup');
    expect(flow.get('t')?.stage).toBe('browser');
    expect(calls.some((line) => line.includes('reason=popup'))).toBe(true);
  });

  it('ignores a duplicate event while the flow is active', async () => {
    const { flow, calls } = setup();
    await flow.begin('t', 'accounts.google.com', 'navigation');
    await flow.begin('t', 'accounts.google.com', 'passkey');

    expect(calls.some((line) => line.includes('ignore duplicate passkey'))).toBe(true);
    expect(flow.get('t')?.stage).toBe('in-tab');
  });

  it('fails over on a provider error page instead of staying there', async () => {
    const { flow, calls } = setup();
    await flow.begin('t', 'accounts.google.com', 'navigation');
    flow.onNavigated('t', 'https://accounts.google.com/signin/oauth/error?authError=1');

    expect(calls).toContain('navigate t https://service.example/');
    expect(calls.some((line) => line.startsWith('notify t'))).toBe(true);
    expect(flow.get('t')?.stage).toBe('failed');
  });

  it('finishes when the tab lands on the service', async () => {
    const { flow, calls } = setup();
    await flow.begin('t', 'accounts.google.com', 'navigation');
    flow.onNavigated('t', 'https://service.example/c/1');
    flow.onSettled('t', 'https://service.example/c/1');

    expect(calls.some((line) => line.includes('stage=done'))).toBe(true);
  });

  it('reloads once, then fails when the service still asks to sign in', async () => {
    const { flow, calls } = setup();
    await flow.begin('t', 'accounts.google.com', 'navigation');

    flow.onSettled('t', 'https://service.example/signin', 'Sign in');
    expect(calls).toContain('reload t');
    expect(flow.get('t')?.stage).toBe('verifying');

    flow.onSettled('t', 'https://service.example/signin', 'Sign in');
    expect(calls.some((line) => line.includes('stage=failed'))).toBe(true);
    expect(flow.get('t')?.stage).toBe('failed');
  });

  it('verifies a session imported from Safari', async () => {
    const { flow, calls } = setup({ browserGoogle: () => 'signed-out' });
    await flow.begin('t', 'accounts.google.com', 'navigation');
    flow.onImported('t', 3);
    expect(flow.get('t')?.stage).toBe('verifying');

    flow.onSettled('t', 'https://service.example/', 'Home');
    expect(calls.some((line) => line.includes('stage=done'))).toBe(true);
  });

  it('marks the flow failed when the Safari watcher ends without a session', async () => {
    const { flow, calls } = setup({ browserGoogle: () => 'signed-out' });
    await flow.begin('t', 'accounts.google.com', 'navigation');
    flow.onWatchEnd('t', 'timeout');

    // The toast for timeout/denied already comes from the browser-sign-in event.
    expect(calls.some((line) => line.startsWith('notify t'))).toBe(false);
    expect(flow.get('t')?.stage).toBe('failed');
  });

  it('reports a failed page load', async () => {
    const { flow, calls } = setup();
    await flow.begin('t', 'accounts.google.com', 'navigation');
    flow.onLoadFailed('t', 'ERR_NAME_NOT_RESOLVED');

    expect(calls.some((line) => line.includes('failed to load'))).toBe(true);
    expect(flow.get('t')?.stage).toBe('failed');
  });

  it('allows a new attempt once an in-tab flow went stale', async () => {
    const { flow, calls, advance } = setup();
    await flow.begin('t', 'accounts.google.com', 'navigation');
    advance(IN_TAB_TTL_MS + 1);
    await flow.begin('t', 'accounts.google.com', 'navigation');

    expect(calls.filter((line) => line.includes('ignore duplicate')).length).toBe(0);
    expect(calls.filter((line) => line.includes('stage=deciding')).length).toBe(2);
  });
});
