/**
 * OpenCode adapter — subscription logins only.
 *
 * OpenCode has no usage windows of its own: it is a client that signs in to somebody
 * else's subscription. So this adapter reads which subscriptions a profile holds and,
 * where that subscription's usage is readable, reports the real thing.
 *
 * For an Anthropic (Claude Pro/Max) login it reuses the same verified endpoints as the
 * Claude adapter, which also reveals whether it is the *same* Claude account — in which
 * case the two rows share one pool and the UI says so rather than letting the user read
 * one quota as two independent budgets.
 *
 * For other subscription logins there is no endpoint this project has verified, so those
 * rows state that plainly instead of showing an invented number.
 *
 * The on-disk shape of auth.json is not part of any published contract, so it is parsed
 * permissively and an unrecognised file produces a clear message naming what was found.
 */

import { createHash } from 'node:crypto';
import { z } from 'zod';
import { makeAccountId, type AccountId } from '@shared/account';
import { allWindows, errored, notConnected, unsupported, type Measurement } from '@shared/window';
import type { AccountScope } from '../scope';
import {
  fetchProfile,
  fetchUsageWindows,
  type AnthropicRequestContext,
} from './anthropic-usage';
import type { AccountIdentity, ProbeContext, ProbeResult, ProviderAdapter } from './types';

const PRODUCT_NAME = 'OpenCode';
const REAUTH_HINT = 'Run `opencode auth login` and sign in again.';

/** Provider keys OpenCode uses for subscription logins, and how to describe them. */
const SUBSCRIPTION_PROVIDERS: Readonly<Record<string, string>> = {
  anthropic: 'Claude Pro/Max',
  openai: 'ChatGPT Plus/Pro',
  'github-copilot': 'GitHub Copilot',
};

/** An OAuth entry. Field names vary across OpenCode versions, so several spellings are accepted. */
const OAuthEntrySchema = z.object({
  type: z.literal('oauth'),
  access: z.string().optional().nullable(),
  access_token: z.string().optional().nullable(),
  refresh: z.string().optional().nullable(),
  expires: z.number().optional().nullable(),
});

/** An API-key entry. Recognised so it can be reported as excluded, never used. */
const KeyEntrySchema = z.object({
  type: z.union([z.literal('api'), z.literal('wellknown')]),
});

const AuthFileSchema = z.record(z.string(), z.unknown());

interface SubscriptionEntry {
  readonly providerKey: string;
  readonly accessToken: string | undefined;
}

export class OpenCodeAdapter implements ProviderAdapter {
  readonly provider = 'opencode' as const;

  defaultConfigDirs(): readonly string[] {
    const fromEnv = process.env['OPENCODE_DATA'];
    const platformDefault =
      process.platform === 'win32'
        ? `${process.env['USERPROFILE'] ?? '~'}\\.local\\share\\opencode`
        : '~/.local/share/opencode';
    return fromEnv !== undefined && fromEnv.trim() !== ''
      ? [fromEnv, platformDefault]
      : [platformDefault];
  }

  async probe(scope: AccountScope, context: ProbeContext): Promise<ProbeResult> {
    if (!(await scope.exists())) {
      return {
        identity: null,
        windows: allWindows(notConnected('OpenCode is not installed', `Looked in ${scope.root}`)),
      };
    }

    const raw = await scope.readJson('auth.json');
    if (raw === undefined) {
      return {
        identity: null,
        windows: allWindows(
          notConnected('no OpenCode logins', 'Run `opencode auth login` and pick a subscription.'),
        ),
      };
    }
    if (!raw.ok) {
      return { identity: null, windows: allWindows(errored('OpenCode auth file is unreadable', raw.reason)) };
    }

    const parsedFile = AuthFileSchema.safeParse(raw.value);
    if (!parsedFile.success) {
      return {
        identity: null,
        windows: allWindows(
          errored('OpenCode auth file has an unexpected shape', 'Expected an object keyed by provider.'),
        ),
      };
    }

    const classified = classifyEntries(parsedFile.data);
    if (classified.subscriptions.length === 0) {
      return {
        identity: null,
        windows: allWindows(describeNoSubscription(classified.apiKeyProviders)),
      };
    }

    // Anthropic first: it is the one subscription whose usage this project can actually read.
    const anthropic = classified.subscriptions.find((entry) => entry.providerKey === 'anthropic');
    if (anthropic?.accessToken != null) {
      return this.probeAnthropic(anthropic.accessToken, scope, context);
    }

    return {
      identity: this.fallbackIdentity(scope, classified.subscriptions),
      windows: allWindows(describeUnreadableSubscriptions(classified.subscriptions)),
    };
  }

  private async probeAnthropic(
    accessToken: string,
    scope: AccountScope,
    context: ProbeContext,
  ): Promise<ProbeResult> {
    const requestContext: AnthropicRequestContext = {
      now: context.now,
      logger: context.logger,
      productName: PRODUCT_NAME,
      reauthHint: REAUTH_HINT,
      ...(context.signal ? { signal: context.signal } : {}),
      ...(context.monthlyCapMinor === undefined ? {} : { monthlyCapMinor: context.monthlyCapMinor }),
    };

    const [windows, profile] = await Promise.all([
      fetchUsageWindows(accessToken, requestContext),
      fetchProfile(accessToken, requestContext),
    ]);

    if (profile === undefined) {
      return {
        identity: this.fallbackIdentity(scope, [{ providerKey: 'anthropic', accessToken }]),
        windows,
      };
    }

    // Same Anthropic account as a Claude row would report, so the quota is one pool.
    const sharesPoolWith: AccountId = makeAccountId('claude', profile.accountUuid);

    return {
      identity: {
        id: makeAccountId('opencode', `anthropic:${profile.accountUuid}`),
        subject: {
          accountUuid: profile.accountUuid,
          ...(profile.email === undefined ? {} : { email: profile.email }),
          ...(profile.orgUuid === undefined ? {} : { orgUuid: profile.orgUuid }),
        },
        label: 'OpenCode',
        ...(profile.plan === undefined ? {} : { plan: profile.plan }),
        subtitle: profile.email === undefined ? 'Claude subscription' : `Claude · ${profile.email}`,
      },
      windows,
      sharesPoolWith,
    };
  }

  /**
   * Used when a login exists but its account cannot be identified.
   *
   * The data directory is the only stable discriminator left, so the id is derived from it.
   * That is weaker than a provider subject — moving the directory mints a new id — which is
   * why it is a last resort rather than the normal path.
   */
  private fallbackIdentity(scope: AccountScope, entries: readonly SubscriptionEntry[]): AccountIdentity {
    const digest = createHash('sha256').update(scope.root).digest('hex').slice(0, 12);
    const names = entries.map((entry) => SUBSCRIPTION_PROVIDERS[entry.providerKey] ?? entry.providerKey);
    return {
      id: makeAccountId('opencode', `dir:${digest}`),
      subject: {},
      label: 'OpenCode',
      subtitle: names.length > 0 ? names.join(', ') : scope.root,
    };
  }
}

interface ClassifiedEntries {
  readonly subscriptions: readonly SubscriptionEntry[];
  readonly apiKeyProviders: readonly string[];
}

/** Exported for tests: splits an auth file into subscription logins and API keys. */
export function classifyEntries(file: Record<string, unknown>): ClassifiedEntries {
  const subscriptions: SubscriptionEntry[] = [];
  const apiKeyProviders: string[] = [];

  for (const [providerKey, value] of Object.entries(file)) {
    const oauth = OAuthEntrySchema.safeParse(value);
    if (oauth.success) {
      const accessToken = oauth.data.access ?? oauth.data.access_token ?? undefined;
      subscriptions.push({ providerKey, accessToken: accessToken ?? undefined });
      continue;
    }
    if (KeyEntrySchema.safeParse(value).success) {
      apiKeyProviders.push(providerKey);
    }
  }

  return { subscriptions, apiKeyProviders };
}

function describeNoSubscription(apiKeyProviders: readonly string[]): Measurement {
  if (apiKeyProviders.length === 0) {
    return notConnected('no OpenCode subscription logins', 'Run `opencode auth login` and pick a subscription.');
  }
  // API keys are metered accounts with no windows, and are out of scope by design.
  return notConnected('OpenCode is using API keys only', `Excluded: ${apiKeyProviders.join(', ')}. This monitor tracks subscriptions only.`);
}

function describeUnreadableSubscriptions(entries: readonly SubscriptionEntry[]): Measurement {
  const names = entries.map((entry) => SUBSCRIPTION_PROVIDERS[entry.providerKey] ?? entry.providerKey);
  return unsupported(
    `no readable usage for ${names.join(', ')}`,
    'These providers publish no verified subscription usage endpoint, so no figure is shown rather than a guessed one.',
  );
}
