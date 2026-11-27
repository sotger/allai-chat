/**
 * The one decision the login flow makes, plus the small helpers it needs.
 *
 * Kept dependency-free and pure so the whole branch tree can be unit-tested:
 * the side effects (sessions, Safari, windows) live in `src/main/login-flow.ts`.
 */

/** Which sign-in provider a navigation went to. */
export type LoginProvider = 'google' | 'microsoft' | 'apple' | 'github' | 'gitlab' | 'clerk' | 'other';

/**
 * How a sign-in started: the tab navigated to a provider, a passkey was blocked,
 * or a popup/`window.open` carried the provider (popups always go to Safari,
 * because the tab-level cookie copy cannot finish a popup round trip).
 */
export type LoginTrigger = 'navigation' | 'passkey' | 'popup';

const PROVIDER_HOSTS: Array<[Exclude<LoginProvider, 'clerk' | 'other'>, string[]]> = [
  ['google', ['accounts.google.com', 'accounts.youtube.com', 'myaccount.google.com']],
  ['microsoft', ['login.microsoftonline.com', 'login.live.com', 'login.microsoft.com']],
  ['apple', ['appleid.apple.com']],
  ['github', ['github.com']],
  ['gitlab', ['gitlab.com']]
];

/** Classifies the host of an auth navigation. */
export function classifyProvider(host: string | undefined): LoginProvider {
  const value = (host ?? '').toLowerCase();
  if (!value) return 'other';
  // Clerk lives both on *.clerk.accounts.dev and on service subdomains.
  if (value.includes('clerk')) return 'clerk';
  for (const [provider, hosts] of PROVIDER_HOSTS) {
    if (hosts.some((domain) => value === domain || value.endsWith(`.${domain}`))) return provider;
  }
  return 'other';
}

/** What "signed in to Google" looks like in the browser right now. */
export type BrowserGoogleState = 'signed-in' | 'signed-out' | 'unknown';

export interface StrategyInput {
  provider: LoginProvider;
  /** `reuseGoogleSignIn` on and the tab is not isolated. */
  sharingEnabled: boolean;
  browserGoogle: BrowserGoogleState;
  vaultHasGoogle: boolean;
  tabHasGoogle: boolean;
}

export type LoginStrategy = 'in-tab' | 'browser';

export interface StrategyChoice {
  strategy: LoginStrategy;
  reason: string;
}

/**
 * Decides whether a sign-in can finish inside the tab or has to go to Safari.
 *
 * Only Google has an in-app answer, and only while the browser itself still
 * holds the login: the vault is a snapshot, and a snapshot must not outlive the
 * session it was taken from. Everything else goes to the browser — Apple and
 * Microsoft passkeys, GitHub, Clerk, and any provider the app has no session
 * for. `unknown` (no Full Disk Access) keeps the old snapshot-based behaviour
 * so the app still works without the permission.
 */
export function chooseStrategy(input: StrategyInput): StrategyChoice {
  if (input.provider !== 'google') {
    return { strategy: 'browser', reason: `provider-${input.provider}` };
  }
  if (!input.sharingEnabled) {
    return { strategy: 'browser', reason: 'sharing-off' };
  }
  if (input.browserGoogle === 'signed-out') {
    return { strategy: 'browser', reason: 'browser-signed-out' };
  }
  if (input.browserGoogle === 'signed-in') {
    return { strategy: 'in-tab', reason: 'browser-signed-in' };
  }
  if (input.vaultHasGoogle || input.tabHasGoogle) {
    return { strategy: 'in-tab', reason: 'vault-fallback' };
  }
  return { strategy: 'browser', reason: 'no-google-session' };
}

/** Paths that mean "this page is asking the visitor to sign in". */
const SIGN_IN_PATH = /(^|\/)(sign-?in|log-?in|login|sso)(\/|$)/i;
/** Provider error endpoints, e.g. Google's /signin/oauth/error. */
const PROVIDER_ERROR_PATH = /\/signin\/oauth\/error|\/o\/oauth2\/error|\/auth\/error|\/oauth\/error/i;

function parse(url: string): URL | undefined {
  try {
    return new URL(url);
  } catch {
    return undefined;
  }
}

export function isSignInPath(url: string): boolean {
  const parsed = parse(url);
  return parsed ? SIGN_IN_PATH.test(parsed.pathname) : false;
}

/**
 * Where the tab should land after a session was taken over. A sign-in URL is
 * replaced by the service origin: replaying `/signin?from=/` after a successful
 * login is what kept the modal on screen even though the session was there.
 */
export function serviceEntryUrl(url: string): string {
  const parsed = parse(url);
  if (!parsed) return url;
  return SIGN_IN_PATH.test(parsed.pathname) ? `${parsed.origin}/` : url;
}

/** True when the URL itself says the provider rejected the request. */
export function isProviderErrorUrl(url: string): boolean {
  const parsed = parse(url);
  if (!parsed) return false;
  const query = parsed.searchParams;
  if (query.has('error') || query.has('authError') || query.has('error_code') || query.has('error_description')) {
    return true;
  }
  return PROVIDER_ERROR_PATH.test(parsed.pathname);
}

/**
 * A provider error page that is served with status 200 (Google's “Error 400”
 * and “Something went wrong” screens). The title is the only cheap signal.
 */
export function looksLikeProviderError(title: string | undefined): boolean {
  if (!title) return false;
  return /(^|\b)(error|400|401|403|429|500|502|503|something went wrong|access denied|request blocked|forbidden)\b/i
    .test(title);
}

/** The cookie fields the login flow compares; Electron's `Cookie` also fits. */
export interface CookieLike {
  domain?: string;
  path?: string;
  name: string;
  value: string;
  expirationDate?: number;
}

/** Stable identity of a cookie, ignoring its value. */
function cookieKey(cookie: CookieLike): string {
  return `${cookie.domain ?? ''}|${cookie.path ?? '/'}|${cookie.name}`;
}

/**
 * True when `target` already holds every cookie in `source` with the same value
 * and expiry. Used to skip a reload when copying a session would change nothing
 * — reloading an OAuth page for no reason is what produced a 400.
 */
export function cookiesSatisfiedBy(source: CookieLike[], target: CookieLike[]): boolean {
  const byKey = new Map(target.map((cookie) => [cookieKey(cookie), cookie]));
  return source.every((cookie) => {
    const other = byKey.get(cookieKey(cookie));
    if (!other) return false;
    if (other.value !== cookie.value) return false;
    const a = other.expirationDate ?? 0;
    const b = cookie.expirationDate ?? 0;
    return Math.abs(a - b) <= 1;
  });
}
