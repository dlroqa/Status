/**
 * First-run discovery.
 *
 * Finds the default account for each provider by probing its well-known config directory.
 * Only accounts that actually identify themselves are added: registering a directory that
 * cannot name its account would create a row with no stable identity behind it.
 *
 * Additional accounts are added by the user, by pointing at another config directory.
 */

import type { Provider } from '@shared/account';
import type { ConfiguredAccount } from '@shared/config';
import type { Logger } from './logger';
import { AccountScope } from './scope';
import type { ProviderAdapter } from './providers/types';

export async function discoverAccounts(
  adapters: Readonly<Record<Provider, ProviderAdapter>>,
  logger: Logger,
  now: Date = new Date(),
): Promise<ConfiguredAccount[]> {
  const discovered: ConfiguredAccount[] = [];
  const seenIds = new Set<string>();

  for (const adapter of Object.values(adapters)) {
    for (const configDir of adapter.defaultConfigDirs()) {
      const scope = new AccountScope(configDir, adapter.companionFiles?.(configDir) ?? []);
      if (!(await scope.exists())) continue;

      let identity;
      try {
        ({ identity } = await adapter.probe(scope, { now, logger }));
      } catch (error) {
        logger.warn(`discovery failed for ${adapter.provider} at ${scope.root}:`, error);
        continue;
      }

      if (identity === null || seenIds.has(identity.id)) continue;

      seenIds.add(identity.id);
      discovered.push({
        id: identity.id,
        provider: adapter.provider,
        label: identity.label,
        configDir,
      });
      // The first directory that yields an identity is this provider's default account.
      break;
    }
  }

  return discovered;
}
