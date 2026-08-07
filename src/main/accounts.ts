/**
 * Account management: everything the accounts panel can change.
 *
 * Kept out of the Electron entry point so it can be tested without a browser window, and
 * so every mutation goes through one place that validates and persists atomically.
 */

import type { Provider } from '@shared/account';
import type { ActionResult, DetectResult, ManagedAccount } from '@shared/ipc';
import type { ConfiguredAccount } from '@shared/config';
import { allStatuses, launchLogin, type CliStatus } from './cli';
import type { ConfigStore } from './config';
import { discoverAccounts } from './discovery';
import type { Logger } from './logger';
import { AccountScope, messageOf } from './scope';
import type { ProviderAdapter } from './providers/types';

export class AccountManager {
  constructor(
    private readonly adapters: Readonly<Record<Provider, ProviderAdapter>>,
    private readonly configStore: ConfigStore,
    private readonly logger: Logger,
  ) {}

  async listAccounts(): Promise<ManagedAccount[]> {
    const { config } = await this.configStore.load();
    return config.accounts.map(toManaged);
  }

  async cliStatuses(): Promise<CliStatus[]> {
    return allStatuses();
  }

  /** Opens the provider's own CLI sign-in. This app never handles the credentials itself. */
  async connect(provider: Provider): Promise<ActionResult> {
    const result = await launchLogin(provider, this.logger);
    return result.ok ? { ok: true, detail: result.detail } : { ok: false, reason: result.reason };
  }

  /**
   * Looks for signed-in sessions that are not yet tracked and registers them.
   *
   * Called after a sign-in completes, and available as a button, because the user may have
   * signed in from their own terminal rather than through Connect.
   */
  async detect(): Promise<DetectResult> {
    const { config, error } = await this.configStore.load();
    if (error !== undefined) {
      return { added: [], reason: `Configuration could not be read: ${error}` };
    }

    let discovered: ConfiguredAccount[];
    try {
      discovered = await discoverAccounts(this.adapters, this.logger);
    } catch (caught) {
      this.logger.error('detection failed:', caught);
      return { added: [], reason: `Detection failed: ${messageOf(caught)}` };
    }

    const known = new Set(config.accounts.map((account) => account.id));
    const additions = discovered.filter((account) => !known.has(account.id));

    if (additions.length === 0) {
      return {
        added: [],
        reason:
          discovered.length === 0
            ? 'No signed-in subscriptions found. Use Connect to sign in to a provider.'
            : 'Every signed-in account is already being tracked.',
      };
    }

    await this.configStore.save({ ...config, accounts: [...config.accounts, ...additions] });
    this.logger.info(`registered ${additions.length} account(s)`);
    return { added: additions.map(toManaged) };
  }

  /**
   * Registers the account signed in inside a specific directory.
   *
   * This is how a second account of the same provider is added: the user points at the
   * config directory that account's CLI was signed in to.
   */
  async addFromFolder(provider: Provider, configDir: string): Promise<ActionResult> {
    const adapter = this.adapters[provider];
    const scope = new AccountScope(configDir, adapter.companionFiles?.(configDir) ?? []);

    let identity;
    try {
      ({ identity } = await adapter.probe(scope, { now: new Date(), logger: this.logger }));
    } catch (error) {
      this.logger.error(`probe failed for ${configDir}:`, error);
      return { ok: false, reason: `Could not read that folder: ${messageOf(error)}` };
    }

    if (identity === null) {
      return {
        ok: false,
        reason: `No signed-in ${provider} session in that folder. Sign in with that folder as the CLI's config directory first.`,
      };
    }

    const { config, error } = await this.configStore.load();
    if (error !== undefined) return { ok: false, reason: `Configuration could not be read: ${error}` };

    if (config.accounts.some((account) => account.id === identity.id)) {
      return { ok: false, reason: `${identity.label} is already being tracked.` };
    }

    const added: ConfiguredAccount = {
      id: identity.id,
      provider,
      label: identity.label,
      configDir,
    };
    await this.configStore.save({ ...config, accounts: [...config.accounts, added] });
    return { ok: true, detail: `Added ${identity.label}` };
  }

  async rename(id: string, label: string): Promise<ActionResult> {
    const trimmed = label.trim();
    if (trimmed.length === 0) return { ok: false, reason: 'A name cannot be empty.' };
    return this.mutate(id, (account) => ({ ...account, label: trimmed }));
  }

  /** Sets the monthly spend cap in minor units, or clears it with null. */
  async setMonthlyCap(id: string, capMinor: number | null): Promise<ActionResult> {
    if (capMinor !== null && (!Number.isFinite(capMinor) || capMinor <= 0)) {
      return { ok: false, reason: 'A monthly cap must be greater than zero.' };
    }
    return this.mutate(id, (account) => {
      const { monthlyCapMinor: _removed, ...rest } = account;
      return capMinor === null ? rest : { ...rest, monthlyCapMinor: Math.round(capMinor) };
    });
  }

  async remove(id: string): Promise<ActionResult> {
    const { config, error } = await this.configStore.load();
    if (error !== undefined) return { ok: false, reason: `Configuration could not be read: ${error}` };

    const remaining = config.accounts.filter((account) => account.id !== id);
    if (remaining.length === config.accounts.length) {
      return { ok: false, reason: 'That account is no longer configured.' };
    }

    await this.configStore.save({ ...config, accounts: remaining });
    // Removing an account only stops this app watching it; the provider session is untouched.
    return { ok: true, detail: 'Stopped tracking. The CLI session was left signed in.' };
  }

  private async mutate(
    id: string,
    change: (account: ConfiguredAccount) => ConfiguredAccount,
  ): Promise<ActionResult> {
    const { config, error } = await this.configStore.load();
    if (error !== undefined) return { ok: false, reason: `Configuration could not be read: ${error}` };

    let found = false;
    const accounts = config.accounts.map((account) => {
      if (account.id !== id) return account;
      found = true;
      return change(account);
    });

    if (!found) return { ok: false, reason: 'That account is no longer configured.' };

    try {
      await this.configStore.save({ ...config, accounts });
    } catch (caught) {
      return { ok: false, reason: `Could not save: ${messageOf(caught)}` };
    }
    return { ok: true };
  }
}

function toManaged(account: ConfiguredAccount): ManagedAccount {
  return {
    id: account.id,
    provider: account.provider,
    label: account.label,
    configDir: account.configDir,
    ...(account.monthlyCapMinor === undefined ? {} : { monthlyCapMinor: account.monthlyCapMinor }),
  };
}
