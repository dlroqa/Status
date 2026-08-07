/**
 * Account identity.
 *
 * An account id is derived from the provider's own subject (the uuid or subject claim in
 * the subscription session), never from the display label or the directory path. That is
 * what guarantees a progress bar stays attached to the account it belongs to: renaming an
 * account or moving its config directory cannot silently re-point a bar at other data.
 */

import type { Measurement, WindowKind } from './window';

export const PROVIDERS = ['claude', 'chatgpt', 'opencode'] as const;
export type Provider = (typeof PROVIDERS)[number];

export const PROVIDER_LABELS: Record<Provider, string> = {
  claude: 'Claude',
  chatgpt: 'ChatGPT',
  opencode: 'OpenCode',
};

export type AccountId = `${Provider}:${string}`;

/**
 * Builds an account id from a provider subject.
 *
 * The subject must be non-empty: an empty subject would collapse every account of a
 * provider onto one id and pool their bars together, which is the exact failure this
 * identity scheme exists to prevent.
 */
export function makeAccountId(provider: Provider, subjectKey: string): AccountId {
  const subject = subjectKey.trim();
  if (subject.length === 0) {
    throw new Error(`cannot build an account id for ${provider} without a subject key`);
  }
  return `${provider}:${subject}`;
}

export function providerOf(id: AccountId): Provider {
  const [provider] = id.split(':', 1);
  return provider as Provider;
}

/** What the provider knows about who this account is. Purely descriptive. */
export interface AccountSubject {
  readonly accountUuid?: string;
  readonly email?: string;
  readonly orgUuid?: string;
}

/** A configured account: one provider, one config directory, one identity. */
export interface Account {
  readonly id: AccountId;
  readonly provider: Provider;
  /** User-facing name. Editable, and never used for identity. */
  readonly label: string;
  /** The only directory this account's data may be read from. */
  readonly configDir: string;
  readonly subject: AccountSubject;
  /** Plan name when the provider reports one, e.g. "Pro". */
  readonly plan?: string;
}

/** One account's windows, as delivered to the UI. */
export interface AccountUsage {
  readonly accountId: AccountId;
  readonly provider: Provider;
  readonly label: string;
  readonly plan?: string;
  readonly subtitle?: string;
  readonly windows: Record<WindowKind, Measurement>;
  /** ISO-8601 instant of the collection pass that produced this. */
  readonly fetchedAt: string;
  /**
   * Set when this account draws from another account's quota — an OpenCode profile signed
   * in with a Claude subscription shares that subscription's 5-hour and weekly pool. The
   * UI marks these so the same quota is never read as two independent budgets.
   */
  readonly sharesPoolWith?: AccountId;
}
