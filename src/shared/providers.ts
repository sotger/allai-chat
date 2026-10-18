import type { ProviderConfig, ProviderId } from './types';

/** AI services available in the "add service" dialog. */
export const PROVIDER_CONFIGS: Record<ProviderId, ProviderConfig> = {
  chatgpt: {
    id: 'chatgpt',
    displayName: 'ChatGPT',
    url: 'https://chatgpt.com',
    color: '#10a37f',
    icon: 'G'
  },
  claude: {
    id: 'claude',
    displayName: 'Claude',
    url: 'https://claude.ai',
    color: '#d4a574',
    icon: 'C'
  },
  gemini: {
    id: 'gemini',
    displayName: 'Gemini',
    url: 'https://gemini.google.com/app',
    color: '#4ecdc4',
    icon: 'Ge'
  },
  copilot: {
    id: 'copilot',
    displayName: 'Copilot',
    url: 'https://copilot.microsoft.com',
    color: '#7c3aed',
    icon: 'Co'
  },
  perplexity: {
    id: 'perplexity',
    displayName: 'Perplexity',
    url: 'https://www.perplexity.ai',
    color: '#f472b6',
    icon: 'P'
  },
  deepseek: {
    id: 'deepseek',
    displayName: 'DeepSeek',
    url: 'https://chat.deepseek.com',
    color: '#58a6ff',
    icon: 'D'
  },
  grok: {
    id: 'grok',
    displayName: 'Grok',
    url: 'https://grok.com',
    color: '#fbbf24',
    icon: 'Gk'
  },
  huggingchat: {
    id: 'huggingchat',
    displayName: 'HuggingChat',
    url: 'https://huggingface.co/chat',
    color: '#ff6b35',
    icon: 'H'
  },
  kimi: {
    id: 'kimi',
    displayName: 'Kimi',
    url: 'https://kimi.moonshot.cn',
    color: '#6366f1',
    icon: 'Ki'
  },
  glm: {
    id: 'glm',
    displayName: 'ChatGLM',
    url: 'https://chatglm.cn',
    color: '#22c55e',
    icon: 'GL'
  },
  mistral: {
    id: 'mistral',
    displayName: 'Le Chat',
    url: 'https://chat.mistral.ai',
    color: '#f97316',
    icon: 'Mi'
  },
  you: {
    id: 'you',
    displayName: 'You.com',
    url: 'https://you.com',
    color: '#06b6d4',
    icon: 'Y'
  },
  phind: {
    id: 'phind',
    displayName: 'Phind',
    url: 'https://www.phind.com',
    color: '#a855f7',
    icon: 'Ph'
  },
  poe: {
    id: 'poe',
    displayName: 'Poe',
    url: 'https://poe.com',
    color: '#84cc16',
    icon: 'Po'
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
  'kimi', 'glm', 'mistral', 'you', 'phind', 'poe', 'custom'
];

export function getProviderConfig(id: ProviderId): ProviderConfig {
  return PROVIDER_CONFIGS[id] ?? PROVIDER_CONFIGS.custom;
}
