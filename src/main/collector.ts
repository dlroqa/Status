/**
 * Polls every configured account and produces the snapshot the UI renders.
 *
 * The integrity guard here is the last of the three mechanisms that keep a progress bar
 * attached to the account it belongs to. The other two are structural — an account id is
 * derived from the provider's own subject, and an adapter can only read inside one
 * AccountScope — but neither can catch the case where a directory's login has *changed*
 * since it was registered. That is a real situation (signing a CLI into a different
 * account reuses the same directory), and showing the new account's numbers under the old
 * account's name would be the worst kind of wrong: plausible and silent.
 */

import type { AccountUsage, Provider } from '@shared/account';
import type { AppConfig, ConfiguredAccount } from '@shared/config';
import { PROVIDER_LABELS } from '@shared/account';
import { allWindows, errored, type Measurement } from '@shared/window';
import type { UsageSnapshot } from '@shared/ipc';
import type { ConfigStore } from './config';
import type { Logger } from './logger';
import { AccountScope, messageOf } from './scope';
import type { ProviderAdapter } from './providers/types';

export class Collector {
  constructor(
    private readonly adapters: Readonly<Record<Provider, ProviderAdapter>>,
    private readonly configStore: ConfigStore,
    private readonly logger: Logger,
  ) {}

  async collect(options: { signal?: AbortSignal; now?: Date } = {}): Promise<UsageSnapshot> {
    const now = options.now ?? new Date();
    const { config, error } = await this.configStore.load();

    const accounts = await Promise.all(
      config.accounts.map((account) => this.collectAccount(account, now, options.signal)),
    );

    return {
      accounts,
      fetchedAt: now.toISOString(),
      refreshing: false,
      ...(error === undefined ? {} : { configError: error }),
    };
  }

  private async collectAccount(
    configured: ConfiguredAccount,
    now: Date,
    signal: AbortSignal | undefined,
  ): Promise<AccountUsage> {
    const adapter = this.adapters[configured.provider];
    const scope = new AccountScope(
      configured.configDir,
      adapter.companionFiles?.(configured.configDir) ?? [],
    );

    let result;
    try {
      result = await adapter.probe(scope, {
        now,
        logger: this.logger,
        ...(signal ? { signal } : {}),
      });
    } catch (error) {
      // An adapter throwing is a bug, not an expected condition; surface it rather than
      // letting one provider's failure blank out the whole window.
      this.logger.error(`adapter ${configured.provider} threw while probing ${scope.root}:`, error);
      return this.usageFor(
        configured,
        allWindows(errored('this account could not be read', messageOf(error))),
        now,
      );
    }

    const { identity, windows } = result;

    // Integrity guard: the directory now belongs to a different account than the one
    // registered against it. Reporting the mismatch is the only honest option — the
    // numbers are real, but they are not this row's numbers.
    if (identity !== null && identity.id !== configured.id) {
      this.logger.warn(
        `account mismatch for ${configured.label}: configured ${configured.id}, directory holds ${identity.id}`,
      );
      return this.usageFor(
        configured,
        allWindows(mismatchMeasurement(identity.label)),
        now,
      );
    }

    const label = configured.label.trim().length > 0 ? configured.label : (identity?.label ?? configured.id);

    return {
      accountId: configured.id as AccountUsage['accountId'],
      provider: configured.provider,
      label,
      windows,
      fetchedAt: now.toISOString(),
      ...(identity?.plan === undefined ? {} : { plan: identity.plan }),
      ...(identity?.subtitle === undefined ? {} : { subtitle: identity.subtitle }),
      ...(result.sharesPoolWith === undefined ? {} : { sharesPoolWith: result.sharesPoolWith }),
    };
  }

  private usageFor(
    configured: ConfiguredAccount,
    windows: Record<'5h' | 'weekly' | 'monthly', Measurement>,
    now: Date,
  ): AccountUsage {
    return {
      accountId: configured.id as AccountUsage['accountId'],
      provider: configured.provider,
      label: configured.label,
      windows,
      fetchedAt: now.toISOString(),
    };
  }
}

function mismatchMeasurement(actualLabel: string): Measurement {
  return errored(
    'this directory now holds a different account',
    `It is signed in as ${actualLabel}. Usage is not shown because it would not belong to this row. Update the account in the config file, or sign back in.`,
  );
}

/** Seeds a config with discovered accounts, keeping any the user already configured. */
export function mergeDiscovered(config: AppConfig, discovered: readonly ConfiguredAccount[]): AppConfig {
  const existing = new Set(config.accounts.map((account) => account.id));
  const additions = discovered.filter((account) => !existing.has(account.id));
  if (additions.length === 0) return config;
  return { ...config, accounts: [...config.accounts, ...additions] };
}

export { PROVIDER_LABELS };
