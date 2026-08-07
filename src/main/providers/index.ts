import type { Provider } from '@shared/account';
import { ClaudeAdapter } from './claude';
import { CodexAdapter } from './codex';
import { OpenCodeAdapter } from './opencode';
import type { ProviderAdapter } from './types';

/** One adapter instance per provider, shared across accounts so identity caches are reused. */
export function createAdapters(): Readonly<Record<Provider, ProviderAdapter>> {
  return {
    claude: new ClaudeAdapter(),
    chatgpt: new CodexAdapter(),
    opencode: new OpenCodeAdapter(),
  };
}

export type { ProviderAdapter } from './types';
