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
}

export interface AppState {
  tabs: ServiceTab[];
  activeTabId: string | null;
}
