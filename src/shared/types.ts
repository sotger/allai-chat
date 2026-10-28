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
}
