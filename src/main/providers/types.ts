/** The contract every provider adapter implements. */

import type { AccountId, AccountSubject, Provider } from '@shared/account';
import type { Measurement, WindowKind } from '@shared/window';
import type { AccountScope } from '../scope';
import type { Logger } from '../logger';

/** Who a config directory currently belongs to, according to the provider itself. */
export interface AccountIdentity {
  readonly id: AccountId;
  readonly subject: AccountSubject;
  /** Suggested display name, used when the user has not set one. */
  readonly label: string;
  readonly plan?: string;
  /** Secondary line under the label, e.g. the account email. */
  readonly subtitle?: string;
}

export interface ProbeResult {
  /** Null when no subscription session exists in this directory. */
  readonly identity: AccountIdentity | null;
  readonly windows: Record<WindowKind, Measurement>;
  /**
   * Set when these windows are the same quota another account reports — an OpenCode
   * profile signed in with a Claude subscription draws from that subscription's pool.
   * The collector keeps this only if that account is actually configured, so the UI can
   * say so instead of the user reading one quota as two independent budgets.
   */
  readonly sharesPoolWith?: AccountId;
}

export interface ProbeContext {
  readonly now: Date;
  readonly logger: Logger;
  readonly signal?: AbortSignal;
}

export interface ProviderAdapter {
  readonly provider: Provider;

  /** Candidate config directories to look in on first run. Order is preference order. */
  defaultConfigDirs(): readonly string[];

  /**
   * Absolute paths outside the config directory this provider legitimately needs.
   * Declared up front so `AccountScope` can authorise them explicitly.
   */
  companionFiles?(configDir: string): readonly string[];

  /** Reads identity and current window usage in one pass. Must never throw for expected conditions. */
  probe(scope: AccountScope, context: ProbeContext): Promise<ProbeResult>;
}
