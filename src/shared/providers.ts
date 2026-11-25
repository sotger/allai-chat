import { GOOGLE_AUTH_COOKIE_NAMES } from './google-auth';
import type { ProviderConfig, ProviderId } from './types';

/** AI services available in the "add service" dialog. */
export const PROVIDER_CONFIGS: Record<ProviderId, ProviderConfig> = {
  chatgpt: {
    id: 'chatgpt',
    displayName: 'ChatGPT',
    url: 'https://chatgpt.com',
    color: '#10a37f',
    icon: 'G',
    newChatUrl: 'https://chatgpt.com/',
    // Opens the same "Continue with Apple" route the dialog uses; the state and
    // nonce are then Safari's own, not the tab's.
    passkeySignInUrl: 'https://chatgpt.com/auth/login_with?connection=apple',
    signInUrl: 'https://chatgpt.com/auth/login'
  },
  claude: {
    id: 'claude',
    displayName: 'Claude',
    url: 'https://claude.ai',
    color: '#d4a574',
    icon: 'C',
    newChatUrl: 'https://claude.ai/new',
    // Claude's own session cookie; it does not contain "session-token".
    sessionCookiePattern: '^sessionKey$'
  },
  gemini: {
    id: 'gemini',
    displayName: 'Gemini',
    url: 'https://gemini.google.com/app',
    color: '#4ecdc4',
    icon: 'Ge',
    newChatUrl: 'https://gemini.google.com/app',
    // Gemini is signed in through Google's own session cookies on .google.com,
    // which also apply to gemini.google.com (parent-domain match).
    sessionCookiePattern: `^(?:${GOOGLE_AUTH_COOKIE_NAMES.join('|')})$`
  },
  copilot: {
    id: 'copilot',
    displayName: 'Copilot',
    url: 'https://copilot.microsoft.com',
    color: '#7c3aed',
    icon: 'Co',
    newChatUrl: 'https://copilot.microsoft.com/'
  },
  perplexity: {
    id: 'perplexity',
    displayName: 'Perplexity',
    url: 'https://www.perplexity.ai',
    color: '#f472b6',
    icon: 'P',
    newChatUrl: 'https://www.perplexity.ai/'
  },
  deepseek: {
    id: 'deepseek',
    displayName: 'DeepSeek',
    url: 'https://chat.deepseek.com',
    color: '#58a6ff',
    icon: 'D',
    newChatUrl: 'https://chat.deepseek.com/'
  },
  grok: {
    id: 'grok',
    displayName: 'Grok',
    url: 'https://grok.com',
    color: '#fbbf24',
    icon: 'Gk',
    newChatUrl: 'https://grok.com/'
  },
  huggingchat: {
    id: 'huggingchat',
    displayName: 'HuggingChat',
    url: 'https://huggingface.co/chat',
    color: '#ff6b35',
    icon: 'H',
    newChatUrl: 'https://huggingface.co/chat/'
  },
  kimi: {
    id: 'kimi',
    displayName: 'Kimi',
    url: 'https://kimi.moonshot.cn',
    color: '#6366f1',
    icon: 'Ki',
    newChatUrl: 'https://kimi.moonshot.cn/'
  },
  glm: {
    id: 'glm',
    displayName: 'ChatGLM',
    url: 'https://chatglm.cn',
    color: '#22c55e',
    icon: 'GL',
    newChatUrl: 'https://chatglm.cn/'
  },
  mistral: {
    id: 'mistral',
    displayName: 'Mistral Vibe',
    url: 'https://chat.mistral.ai',
    color: '#f97316',
    icon: 'Mi',
    newChatUrl: 'https://chat.mistral.ai/chat'
  },
  you: {
    id: 'you',
    displayName: 'You.com',
    url: 'https://you.com',
    color: '#06b6d4',
    icon: 'Y',
    newChatUrl: 'https://you.com/'
  },
  phind: {
    id: 'phind',
    displayName: 'Phind',
    url: 'https://www.phind.com',
    color: '#a855f7',
    icon: 'Ph',
    newChatUrl: 'https://www.phind.com/'
  },
  poe: {
    id: 'poe',
    displayName: 'Poe',
    url: 'https://poe.com',
    color: '#84cc16',
    icon: 'Po',
    newChatUrl: 'https://poe.com/'
  },
  custom: {
    id: 'custom',
    displayName: 'Custom URL',
    url: '',
    color: '#8b949e',
    icon: '+'
  }
};

export const PROVIDER_LIST: ProviderId[] = [
  'chatgpt', 'claude', 'gemini', 'copilot', 'perplexity', 'deepseek', 'grok', 'huggingchat',
  'kimi', 'glm', 'mistral', 'phind', 'poe', 'custom'
];

/**
 * Providers that are no longer offered in "Add service" but must stay in
 * PROVIDER_CONFIGS so tabs saved by older versions still resolve.
 */
export const RETIRED_PROVIDER_LIST: ProviderId[] = ['you'];

export function getProviderConfig(id: ProviderId): ProviderConfig {
  return PROVIDER_CONFIGS[id] ?? PROVIDER_CONFIGS.custom;
}
