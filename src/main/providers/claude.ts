/**
 * Claude (claude.ai subscription) adapter.
 *
 * Reads the OAuth session Claude Code already holds and asks Anthropic for the account's
 * own utilisation. This is subscription authentication — the same session the CLI uses —
 * not an API key, and the numbers are the provider's own, not a local estimate.
 *
 * The session lives in two places depending on the platform: a file under the config
 * directory on Linux and Windows, and the login Keychain on macOS.
 *
 * This adapter never writes a credential. When the session has expired it asks the official
 * client to refresh — by running its own read-only status command — and then re-reads the
 * result. Performing the OAuth refresh here instead would require the client's client_id,
 * which no vendor issues to third parties and which this project does not embed.
 */

import { createHash } from 'node:crypto';
import { z } from 'zod';
import { makeAccountId } from '@shared/account';
import { needsRefresh, sessionStatus } from '@shared/session';
import { allWindows, errored, notConnected, type Measurement } from '@shared/window';
import { refreshSessionViaCli } from '../cli';
import { expandHome, type AccountScope } from '../scope';
import { readCredentialsFile, readMacKeychainCredentials } from './credentials';
import {
  fetchProfile,
  fetchUsageWindows,
  type AnthropicProfile,
  type AnthropicRequestContext,
} from './anthropic-usage';
import type { AccountIdentity, ProbeContext, ProbeResult, ProviderAdapter } from './types';

const PRODUCT_NAME = 'Claude';
const REAUTH_HINT = 'Run `claude` and sign in again to refresh the session.';

/** Identity changes far more slowly than usage, so it is not re-fetched on every poll. */
const IDENTITY_TTL_MS = 15 * 60 * 1000;

const CredentialsSchema = z.object({
  claudeAiOauth: z.object({
    accessToken: z.string().min(1),
    subscriptionType: z.string().optional(),
    /** Milliseconds since the epoch, as Claude Code records it. */
    expiresAt: z.number().optional(),
  }),
});

interface CachedIdentity {
  readonly identity: AccountIdentity;
  readonly expiresAtMs: number;
}

export class ClaudeAdapter implements ProviderAdapter {
  readonly provider = 'claude' as const;

  /**
   * Keyed by a digest of the access token, never the token itself.
   *
   * A new token still misses the cache, because a different token digests differently — but
   * Map keys are held strongly, so keying on the raw value would keep a live credential in
   * the heap for the lifetime of the process.
   */
  private readonly identityCache = new Map<string, CachedIdentity>();

  defaultConfigDirs(): readonly string[] {
    const fromEnv = process.env['CLAUDE_CONFIG_DIR'];
    return fromEnv !== undefined && fromEnv.trim() !== '' ? [fromEnv, '~/.claude'] : ['~/.claude'];
  }

  async probe(scope: AccountScope, context: ProbeContext): Promise<ProbeResult> {
    const session = await this.readFreshSession(scope, context);
    if (!session.ok) {
      return { identity: null, windows: allWindows(session.measurement) };
    }

    const requestContext: AnthropicRequestContext = {
      now: context.now,
      logger: context.logger,
      productName: PRODUCT_NAME,
      reauthHint: REAUTH_HINT,
      ...(context.signal ? { signal: context.signal } : {}),
      ...(context.monthlyCapMinor === undefined ? {} : { monthlyCapMinor: context.monthlyCapMinor }),
    };

    // Both calls use the same session; running them together keeps one poll to one round trip each.
    let [windows, identity] = await Promise.all([
      fetchUsageWindows(session.accessToken, requestContext),
      this.resolveIdentity(session.accessToken, session.subscriptionType, requestContext),
    ]);

    /*
     * The stored expiry said the session was fine but the server disagreed — a revoked token,
     * or a clock that is out by enough to matter. Ask the client to refresh and try once
     * more, so a recoverable rejection does not surface as "sign in again".
     */
    if (isExpiredRejection(windows) && (await refreshSessionViaCli('claude', context.logger))) {
      const retried = await readSession(scope, this.defaultConfigDirs());
      if (retried.ok && retried.accessToken !== session.accessToken) {
        context.logger.info('Claude session was refreshed after a rejection; retrying');
        [windows, identity] = await Promise.all([
          fetchUsageWindows(retried.accessToken, requestContext),
          this.resolveIdentity(retried.accessToken, retried.subscriptionType, requestContext),
        ]);
      }
    }

    return { identity, windows };
  }

  /**
   * Reads the session, asking the official client to refresh it first if it has expired.
   *
   * The app cannot perform the OAuth refresh itself — that needs the client's client_id,
   * which no vendor issues to third parties. Running the client's own read-only status
   * command makes it notice the expiry and exchange its refresh token, after which the
   * updated session is re-read from wherever it lives. Without this the app would sit on a
   * stale token and report a 401 as though the user had done something wrong.
   */
  private async readFreshSession(
    scope: AccountScope,
    context: ProbeContext,
  ): Promise<({ ok: true } & Session) | { ok: false; measurement: Measurement }> {
    const first = await readSession(scope, this.defaultConfigDirs());
    if (!first.ok) return first;

    const status = sessionStatus(first.expiresAt, context.now);
    if (!needsRefresh(status)) return first;

    context.logger.info(`Claude session is ${status.state}; asking the client to refresh`);
    const ran = await refreshSessionViaCli('claude', context.logger);
    if (!ran) {
      // Nothing to refresh with: report it rather than firing a request that must fail.
      return {
        ok: false,
        measurement: errored(
          'Claude session expired',
          'The claude client could not be run to refresh it. Press Sign in to authenticate again.',
        ),
      };
    }

    const second = await readSession(scope, this.defaultConfigDirs());
    if (!second.ok) return second;

    const refreshed = sessionStatus(second.expiresAt, context.now);
    if (refreshed.state === 'expired') {
      return {
        ok: false,
        measurement: errored(
          'Claude session expired',
          'Refreshing it did not help — the refresh token has probably expired too. Press Sign in to authenticate again.',
        ),
      };
    }
    return second;
  }

  private async resolveIdentity(
    accessToken: string,
    subscriptionType: string | undefined,
    context: AnthropicRequestContext,
  ): Promise<AccountIdentity | null> {
    const cacheKey = digestOf(accessToken);
    const cached = this.identityCache.get(cacheKey);
    if (cached !== undefined && cached.expiresAtMs > context.now.getTime()) {
      return cached.identity;
    }

    const profile = await fetchProfile(accessToken, context);
    if (profile === undefined) {
      // Usage may still be readable; the collector keeps the configured identity in that case.
      return null;
    }

    const identity = toIdentity(profile, subscriptionType);
    this.identityCache.set(cacheKey, {
      identity,
      expiresAtMs: context.now.getTime() + IDENTITY_TTL_MS,
    });
    return identity;
  }
}

/** True when every window failed for the one reason a refresh can fix. */
function isExpiredRejection(windows: Record<string, Measurement>): boolean {
  return Object.values(windows).every(
    (measurement) => measurement.state === 'error' && measurement.reason.includes('session expired'),
  );
}

/** One-way digest used purely as a cache key, so no token is retained in memory. */
function digestOf(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function toIdentity(profile: AnthropicProfile, subscriptionType: string | undefined): AccountIdentity {
  const plan = profile.plan ?? titleCase(subscriptionType);
  return {
    id: makeAccountId('claude', profile.accountUuid),
    subject: {
      accountUuid: profile.accountUuid,
      ...(profile.email === undefined ? {} : { email: profile.email }),
      ...(profile.orgUuid === undefined ? {} : { orgUuid: profile.orgUuid }),
    },
    label: profile.name ?? profile.email ?? 'Claude account',
    ...(plan === undefined ? {} : { plan }),
    ...(profile.email === undefined ? {} : { subtitle: profile.email }),
  };
}

interface Session {
  readonly accessToken: string;
  readonly subscriptionType?: string;
  readonly expiresAt?: number;
}

/**
 * Finds the Claude session for this account.
 *
 * Two places, because Claude Code uses two. On Linux and Windows the session is a file in
 * the config directory; on macOS the same JSON lives in the login Keychain instead.
 */
async function readSession(
  scope: AccountScope,
  defaultDirs: readonly string[],
): Promise<({ ok: true } & Session) | { ok: false; measurement: Measurement }> {
  const fromFile = await readCredentialsFile(scope, '.credentials.json');
  if (fromFile.found) return parseSession(fromFile.value, fromFile.source);
  if (fromFile.reason !== undefined) {
    return { ok: false, measurement: errored('Claude credentials file is unreadable', fromFile.reason) };
  }

  /*
   * The Keychain holds one entry for the whole user account, not one per config directory.
   * Consulting it for a non-default directory would show the default account's usage under
   * a second account's name — the exact cross-attribution the rest of the design prevents —
   * so it is only read for the directory Claude Code actually uses.
   */
  if (process.platform === 'darwin' && isDefaultDirectory(scope, defaultDirs)) {
    const fromKeychain = await readMacKeychainCredentials();
    if (fromKeychain.found) return parseSession(fromKeychain.value, fromKeychain.source);
    if (fromKeychain.reason !== undefined) {
      return { ok: false, measurement: errored('Could not read the Claude session', fromKeychain.reason) };
    }
  }

  if (!(await scope.exists()) && process.platform !== 'darwin') {
    return {
      ok: false,
      measurement: notConnected('no Claude config directory', `Looked in ${scope.root}`),
    };
  }

  return {
    ok: false,
    measurement: notConnected(
      'not signed in to Claude',
      process.platform === 'darwin'
        ? 'Press Sign in, or run `claude auth login`. On macOS the session is kept in your login Keychain.'
        : 'Press Sign in, or run `claude auth login`.',
    ),
  };
}

function parseSession(
  value: unknown,
  source: string,
): ({ ok: true } & Session) | { ok: false; measurement: Measurement } {
  const parsed = CredentialsSchema.safeParse(value);
  if (!parsed.success) {
    return {
      ok: false,
      measurement: notConnected(
        'no Claude subscription session found',
        `${source} holds no claude.ai OAuth session. Press Sign in to authenticate.`,
      ),
    };
  }

  const { accessToken, subscriptionType, expiresAt } = parsed.data.claudeAiOauth;
  return {
    ok: true,
    accessToken,
    ...(subscriptionType === undefined ? {} : { subscriptionType }),
    ...(expiresAt === undefined ? {} : { expiresAt }),
  };
}

/** True when this scope points at the directory Claude Code itself uses. */
function isDefaultDirectory(scope: AccountScope, defaultDirs: readonly string[]): boolean {
  return defaultDirs.some((dir) => expandHome(dir) === scope.root);
}

function titleCase(value: string | undefined): string | undefined {
  if (value === undefined || value.length === 0) return undefined;
  return value.charAt(0).toUpperCase() + value.slice(1);
}
