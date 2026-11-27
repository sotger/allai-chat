import {
  chooseStrategy,
  classifyProvider,
  isProviderErrorUrl,
  isSignInPath,
  looksLikeProviderError,
  type BrowserGoogleState,
  type LoginProvider,
  type LoginTrigger
} from '@shared/login-policy';

export type LoginStage = 'in-tab' | 'browser' | 'verifying' | 'failed' | 'done';

export interface LoginFlow {
  id: string;
  tabId: string;
  stage: LoginStage;
  trigger: LoginTrigger;
  provider: LoginProvider;
  providerHost?: string;
  startedAt: number;
  /** When the current stage last changed. */
  changedAt: number;
  /** One service reload has already been spent on verification. */
  reloaded: boolean;
  reason?: string;
}

export interface LoginFlowHooks {
  now(): number;
  newId(): string;
  log(line: string): void;
  /** True when shared Google sign-in applies to this tab. */
  sharingEnabled(tabId: string): boolean;
  browserGoogle(): BrowserGoogleState;
  vaultHasGoogle(): Promise<boolean>;
  tabHasGoogle(tabId: string): Promise<boolean>;
  /** Copies the live browser Google session into the tab; 0 when already current. */
  copyBrowserGoogle(tabId: string): Promise<number>;
  /** Copies the stored Google session into the tab; 0 when already current. */
  copyVaultGoogle(tabId: string): Promise<number>;
  /** Reloads the provider page once it has committed (never the service page). */
  reloadProvider(tabId: string): void;
  /** Reloads the tab's current page (used for the one verification retry). */
  reloadTab(tabId: string): void;
  navigateTab(tabId: string, url: string): void;
  openBrowser(tabId: string, trigger: LoginTrigger): void;
  notify(tabId: string, message: string): void;
  /** Service URL to land on after a session was taken over. */
  entryUrl(tabId: string): string;
  /** True for provider sign-in hosts (accounts.google.com, appleid.apple.com, …). */
  isAuthUrl(url: string): boolean;
}

/** How long an in-tab attempt may stay unfinished before a new one is allowed. */
export const IN_TAB_TTL_MS = 2 * 60_000;
/** A finished flow keeps blocking duplicates for a moment (a page may retry). */
export const FAILED_GRACE_MS = 5_000;
/** The Safari watcher gives up after 10 minutes; a browser flow older than that is dead. */
export const BROWSER_TTL_MS = 11 * 60_000;

/**
 * One login state machine per tab, covering every way a sign-in can start:
 *
 * - the service navigates itself to a provider (`navigation`);
 * - the page asks for a passkey we cannot service (`passkey`);
 * - the user picks “Sign in via Safari” in the tab menu (browser only).
 *
 * It replaces the old tangle of a 3-minute global suppression window and a
 * passkey path that ignored it. Every state here is explicit, and every
 * transition is logged with the flow id, so a failure can be read back from
 * `browser-sign-in.log` instead of guessed.
 *
 * States:
 * - `in-tab`   — the session was copied into the tab and the provider page was
 *                reloaded (only when the cookies actually changed);
 * - `browser`  — Safari holds the login, a cookie watcher waits for the session;
 * - `verifying`— the session was imported or the tab left the provider; the
 *                service is checked once, with a single reload;
 * - `done` / `failed` — terminal, kept briefly to absorb page retries.
 */
export class LoginFlowController {
  private readonly flows = new Map<string, LoginFlow>();

  constructor(private readonly hooks: LoginFlowHooks) {}

  get(tabId: string): LoginFlow | undefined {
    return this.flows.get(tabId);
  }

  /** Entrance for an auth navigation and for a blocked passkey. */
  async begin(tabId: string, providerHost: string | undefined, trigger: LoginTrigger): Promise<void> {
    const current = this.flows.get(tabId);
    if (current && !this.stale(current)) {
      this.log(current, `ignore duplicate ${trigger} host=${providerHost ?? '-'}`);
      return;
    }

    const provider = classifyProvider(providerHost);
    // A popup owns its own round trip; the tab-level copy cannot complete it.
    const sharing = provider === 'google' && trigger !== 'popup' ? this.hooks.sharingEnabled(tabId) : false;
    const browserGoogle = provider === 'google' && trigger !== 'popup'
      ? this.hooks.browserGoogle()
      : 'unknown';
    const vaultHas = provider === 'google' && sharing ? await this.hooks.vaultHasGoogle() : false;
    const tabHas = provider === 'google' && sharing ? await this.hooks.tabHasGoogle(tabId) : false;
    const choice = trigger === 'popup'
      ? { strategy: 'browser' as const, reason: 'popup' }
      : chooseStrategy({
        provider,
        sharingEnabled: sharing,
        browserGoogle,
        vaultHasGoogle: vaultHas,
        tabHasGoogle: tabHas
      });

    const flow: LoginFlow = {
      id: this.hooks.newId(),
      tabId,
      stage: 'in-tab',
      trigger,
      provider,
      providerHost,
      startedAt: this.hooks.now(),
      changedAt: this.hooks.now(),
      reloaded: false,
      reason: choice.reason
    };
    this.flows.set(tabId, flow);
    this.hooks.log(
      `flow=${flow.id} tab=${tabId} stage=deciding trigger=${trigger} provider=${provider} `
      + `host=${providerHost ?? '-'} browser=${browserGoogle} vault=${vaultHas} tab=${tabHas} `
      + `-> ${choice.strategy} (${choice.reason})`
    );

    if (choice.strategy === 'browser') {
      this.openBrowser(flow);
      return;
    }

    let copied = 0;
    try {
      copied = browserGoogle === 'signed-in'
        ? await this.hooks.copyBrowserGoogle(tabId)
        : await this.hooks.copyVaultGoogle(tabId);
    } catch (error) {
      this.hooks.log(`flow=${flow.id} tab=${tabId} copy failed: ${String(error)}`);
    }

    // `tabHas` covers the case where the right cookies are already in the tab:
    // nothing to copy, nothing to reload — the page can simply continue.
    if (copied === 0 && !tabHas) {
      flow.stage = 'browser';
      flow.changedAt = this.hooks.now();
      this.hooks.log(`flow=${flow.id} tab=${tabId} no cookies to copy -> browser`);
      this.hooks.openBrowser(tabId, trigger);
      return;
    }

    flow.stage = 'in-tab';
    flow.changedAt = this.hooks.now();
    this.hooks.log(
      `flow=${flow.id} tab=${tabId} stage=in-tab copied=${copied}`
      + (copied === 0 ? ' (tab already current)' : '')
    );
    if (copied > 0) this.hooks.reloadProvider(tabId);
  }

  /** Called on every main-frame navigation of a tab. */
  onNavigated(tabId: string, url: string): void {
    const flow = this.flows.get(tabId);
    if (!flow) return;

    if (isProviderErrorUrl(url)) {
      this.fail(flow, `the sign-in provider returned an error page (${summarize(url)})`, true);
      return;
    }

    if (flow.stage === 'in-tab' && !this.hooks.isAuthUrl(url)) {
      // The tab left the provider: the round trip either finished or bounced
      // back to the service. The verdict is taken once the page settles.
      flow.stage = 'verifying';
      flow.changedAt = this.hooks.now();
      this.hooks.log(`flow=${flow.id} tab=${tabId} stage=verifying left provider -> ${summarize(url)}`);
    }
  }

  /** Called when a tab finishes loading (`did-stop-loading`). */
  onSettled(tabId: string, url: string, title?: string): void {
    const flow = this.flows.get(tabId);
    if (!flow) return;

    if (flow.stage === 'in-tab') {
      if (this.hooks.isAuthUrl(url) && looksLikeProviderError(title)) {
        this.fail(flow, `the sign-in provider showed an error page (“${title}”)`, true);
        return;
      }
      if (!this.hooks.isAuthUrl(url)) {
        flow.stage = 'verifying';
        flow.changedAt = this.hooks.now();
      } else {
        return;
      }
    }

    if (flow.stage !== 'verifying') return;

    if (this.hooks.isAuthUrl(url)) {
      // Bounced back to the provider: the round trip is still running, not a
      // finished sign-in. Wait for it instead of failing the flow.
      flow.stage = 'in-tab';
      flow.changedAt = this.hooks.now();
      this.hooks.log(`flow=${flow.id} tab=${tabId} back on the provider, waiting`);
      return;
    }

    if (!isSignInPath(url)) {
      this.done(flow);
      return;
    }
    if (!flow.reloaded) {
      flow.reloaded = true;
      flow.changedAt = this.hooks.now();
      this.hooks.log(`flow=${flow.id} tab=${tabId} stage=verifying service still asks to sign in, reloading once`);
      this.hooks.reloadTab(tabId);
      return;
    }
    this.fail(flow, 'the session was taken over, but the service still asks to sign in', false);
  }

  /** The session was imported from Safari. */
  onImported(tabId: string, imported: number): void {
    const flow = this.flows.get(tabId);
    if (!flow) return;
    flow.stage = 'verifying';
    flow.changedAt = this.hooks.now();
    this.hooks.log(`flow=${flow.id} tab=${tabId} stage=verifying imported=${imported}`);
  }

  /** The Safari watcher ended without a session. */
  onWatchEnd(tabId: string, state: 'timeout' | 'denied'): void {
    const flow = this.flows.get(tabId);
    if (!flow) return;
    // The watcher result is already rendered by the browser-sign-in event, so
    // this is only the flow bookkeeping (a second toast would be noise).
    this.fail(
      flow,
      state === 'denied'
        ? 'Safari cookies are blocked (Full Disk Access missing)'
        : 'Safari did not hand over a session in time',
      false,
      false
    );
  }

  /** A page failed to load (network, certificate, aborted navigation). */
  onLoadFailed(tabId: string, description: string): void {
    const flow = this.flows.get(tabId);
    if (!flow) return;
    this.fail(flow, `the page failed to load (${description})`, true);
  }

  cancel(tabId: string): void {
    const flow = this.flows.get(tabId);
    if (!flow) return;
    this.hooks.log(`flow=${flow.id} tab=${tabId} cancelled`);
    this.flows.delete(tabId);
  }

  private openBrowser(flow: LoginFlow): void {
    flow.stage = 'browser';
    flow.changedAt = this.hooks.now();
    this.hooks.log(
      `flow=${flow.id} tab=${flow.tabId} stage=browser reason=${flow.reason ?? '-'} `
      + `provider=${flow.provider}`
    );
    this.hooks.openBrowser(flow.tabId, flow.trigger);
  }

  private done(flow: LoginFlow): void {
    flow.stage = 'done';
    flow.changedAt = this.hooks.now();
    this.hooks.log(`flow=${flow.id} tab=${flow.tabId} stage=done`);
  }

  private fail(flow: LoginFlow, reason: string, recover: boolean, notify = true): void {
    flow.stage = 'failed';
    flow.changedAt = this.hooks.now();
    flow.reason = reason;
    this.hooks.log(`flow=${flow.id} tab=${flow.tabId} stage=failed reason=${reason}`);
    if (notify) this.hooks.notify(flow.tabId, reason);
    if (recover) this.hooks.navigateTab(flow.tabId, this.hooks.entryUrl(flow.tabId));
  }

  private stale(flow: LoginFlow): boolean {
    const now = this.hooks.now();
    const age = now - flow.changedAt;
    if (flow.stage === 'done' || flow.stage === 'failed') return age > FAILED_GRACE_MS;
    if (flow.stage === 'browser') return age > BROWSER_TTL_MS;
    return age > IN_TAB_TTL_MS;
  }

  private log(flow: LoginFlow, message: string): void {
    this.hooks.log(`flow=${flow.id} tab=${flow.tabId} ${message}`);
  }
}

/** `host/path` only: query strings can carry OAuth codes and state. */
function summarize(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.host}${parsed.pathname}`;
  } catch {
    return 'invalid-url';
  }
}
