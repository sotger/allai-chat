export type ProviderId =
  | 'chatgpt'
  | 'claude'
  | 'gemini'
  | 'copilot'
  | 'perplexity'
  | 'deepseek'
  | 'grok'
  | 'huggingchat'
  | 'kimi'
  | 'glm'
  | 'mistral'
  | 'you'
  | 'phind'
  | 'poe'
  | 'custom';

export interface ProviderConfig {
  id: ProviderId;
  displayName: string;
  url: string;
  color: string;
  icon: string;
  /**
   * Address that starts an empty conversation. Used as a fallback when the
   * page has no clickable "New chat" control (custom services have none).
   */
  newChatUrl?: string;
  /**
   * Where the Safari handoff opens when a passkey button was blocked: the
   * service's own entry into its federated sign-in, so the browser lands one
   * click away from the provider instead of on the service home page. Only
   * used when it shares the tab's host — cookies are matched by host.
   */
  passkeySignInUrl?: string;
  /**
   * The service's own login page, opened by the browser handoff when the page
   * bounced to a sign-in provider. Saves a click inside the browser.
   */
  signInUrl?: string;
  /**
   * Regex source (used case-insensitively) for a cookie name that means "this
   * profile is signed in" for the service. The handoff waits for such a cookie
   * before importing, so device ids and cache cookies cannot end the watch.
   * Falls back to the ChatGPT rule (`*session-token` / `session`).
   */
  sessionCookiePattern?: string;
}

/** One vertical tab: an isolated session running a single AI service. */
export interface ServiceTab {
  id: string;
  providerId: ProviderId;
  label: string;
  url: string;
  /** Electron session partition, unique per tab (multiple accounts supported). */
  partition: string;
  color: string;
  icon: string;
  createdAt: string;
  /**
   * Opt this tab out of the shared Google sign-in vault. Useful when the same
   * service is opened twice with two different Google accounts.
   */
  isolatedAuth?: boolean;
}

export interface AppState {
  tabs: ServiceTab[];
  activeTabId: string | null;
}

export type ThemePreference = 'system' | 'light' | 'dark';

export interface Preferences {
  /** Follow the OS theme, or force light/dark for the UI and webviews. */
  theme: ThemePreference;
  /** Folder where downloads are saved. */
  downloadDirectory: string;
  /**
   * Copy Google sign-in cookies into service sessions that do not have their
   * own yet, so "Continue with Google" does not ask for the password in every
   * tab. Disabled means every tab signs in independently.
   */
  reuseGoogleSignIn: boolean;
  /**
   * Short, non-reversible fingerprint of the Google login stored in the app's
   * own profile. Used only to notice that a login elsewhere used a different
   * account, so the saved one is not replaced without the user asking. Never
   * the cookie itself.
   */
  googleVaultSession?: string;
  /** Base interface font size in px: 13 (default), 14, 15 or 16. */
  uiFontSize: number;
  /**
   * Capture the text of conversations you open into a local, searchable index.
   * Everything stays on disk in the app's userData folder.
   */
  historyIndexEnabled: boolean;
  /**
   * Fill the index from a hidden window in the background. Off by default: it
   * walks older conversations at a human pace, so it is opt-in.
   */
  historyBackfillEnabled: boolean;
  /**
   * Folder that a cloud client already syncs (iCloud Drive, Google Drive,
   * OneDrive, Dropbox, Nextcloud, a network share). The app writes one portable
   * file per device there; it never talks to a cloud API.
   */
  syncFolder: string;
  /** Write/merge the sync file automatically in `syncFolder`. */
  syncEnabled: boolean;
  /**
   * The user asked not to be warned again about the missing Full Disk Access
   * grant, which the Safari browser handoff needs to read cookies.
   */
  fullDiskAccessNoticeHidden: boolean;
}
