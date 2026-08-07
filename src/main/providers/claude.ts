/**
 * Claude (claude.ai subscription) adapter.
 *
 * Reads the OAuth session Claude Code already holds and asks Anthropic for the account's
 * own utilisation. This is subscription authentication — the same session the CLI uses —
 * not an API key, and the numbers are the provider's own, not a local estimate.
 *
 * This adapter never writes. Refreshing the CLI's token behind its back could invalidate
 * the user's login, so an expired session is reported for the user to fix, not repaired.
 */

import { z } from 'zod';
import { makeAccountId } from '@shared/account';
import { allWindows, errored, notConnected, type Measurement } from '@shared/window';
import type { AccountScope } from '../scope';
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
  }),
});

interface CachedIdentity {
  readonly identity: AccountIdentity;
  readonly expiresAtMs: number;
}

export class ClaudeAdapter implements ProviderAdapter {
  readonly provider = 'claude' as const;

  /** Keyed by access token: a new token means a possibly different account. */
  private readonly identityCache = new Map<string, CachedIdentity>();

  defaultConfigDirs(): readonly string[] {
    const fromEnv = process.env['CLAUDE_CONFIG_DIR'];
    return fromEnv !== undefined && fromEnv.trim() !== '' ? [fromEnv, '~/.claude'] : ['~/.claude'];
  }

  async probe(scope: AccountScope, context: ProbeContext): Promise<ProbeResult> {
    const session = await readSession(scope);
    if (!session.ok) {
      return { identity: null, windows: allWindows(session.measurement) };
    }

    const requestContext: AnthropicRequestContext = {
      now: context.now,
      logger: context.logger,
      productName: PRODUCT_NAME,
      reauthHint: REAUTH_HINT,
      ...(context.signal ? { signal: context.signal } : {}),
    };

    // Both calls use the same session; running them together keeps one poll to one round trip each.
    const [windows, identity] = await Promise.all([
      fetchUsageWindows(session.accessToken, requestContext),
      this.resolveIdentity(session.accessToken, session.subscriptionType, requestContext),
    ]);

    return { identity, windows };
  }

  private async resolveIdentity(
    accessToken: string,
    subscriptionType: string | undefined,
    context: AnthropicRequestContext,
  ): Promise<AccountIdentity | null> {
    const cached = this.identityCache.get(accessToken);
    if (cached !== undefined && cached.expiresAtMs > context.now.getTime()) {
      return cached.identity;
    }

    const profile = await fetchProfile(accessToken, context);
    if (profile === undefined) {
      // Usage may still be readable; the collector keeps the configured identity in that case.
      return null;
    }

    const identity = toIdentity(profile, subscriptionType);
    this.identityCache.set(accessToken, {
      identity,
      expiresAtMs: context.now.getTime() + IDENTITY_TTL_MS,
    });
    return identity;
  }
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
}

async function readSession(
  scope: AccountScope,
): Promise<({ ok: true } & Session) | { ok: false; measurement: Measurement }> {
  if (!(await scope.exists())) {
    return {
      ok: false,
      measurement: notConnected('no Claude config directory', `Looked in ${scope.root}`),
    };
  }

  const raw = await scope.readJson('.credentials.json');
  if (raw === undefined) {
    return {
      ok: false,
      measurement: notConnected('not signed in to Claude', 'Run `claude` and sign in to your subscription.'),
    };
  }
  if (!raw.ok) {
    return { ok: false, measurement: errored('Claude credentials file is unreadable', raw.reason) };
  }

  const parsed = CredentialsSchema.safeParse(raw.value);
  if (!parsed.success) {
    return {
      ok: false,
      measurement: notConnected(
        'no Claude subscription session found',
        'The credentials file holds no claude.ai OAuth session. Run `claude` and sign in.',
      ),
    };
  }

  const { accessToken, subscriptionType } = parsed.data.claudeAiOauth;
  return { ok: true, accessToken, ...(subscriptionType === undefined ? {} : { subscriptionType }) };
}

function titleCase(value: string | undefined): string | undefined {
  if (value === undefined || value.length === 0) return undefined;
  return value.charAt(0).toUpperCase() + value.slice(1);
}
