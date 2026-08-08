/**
 * OpenCode adapter — subscription logins only.
 *
 * OpenCode has no usage windows of its own: it is a client that signs in to somebody else's
 * subscription. So this adapter reads which subscriptions a profile holds and, where that
 * subscription's usage is readable, reports the real thing.
 *
 * For an Anthropic (Claude Pro/Max) login it reuses the same verified endpoints as the Claude
 * adapter, which also reveals whether it is the *same* Claude account — in which case the two
 * rows share one pool and the UI says so rather than letting the user read one quota as two
 * independent budgets.
 *
 * The shapes below follow OpenCode's own `src/auth/index.ts`, which stores a union
 * discriminated on `type`:
 *
 *   oauth     { refresh, access, expires, accountId?, enterpriseUrl? }
 *   api       { key, metadata? }
 *   wellknown { key, token }
 *
 * The data directory and the `auth`/`providers` command names were checked against the
 * installed binary rather than inferred: `opencode auth list` prints the path it uses, and
 * honours `XDG_DATA_HOME`.
 */

import { createHash } from 'node:crypto';
import { z } from 'zod';
import { makeAccountId, type AccountId } from '@shared/account';
import { needsRefresh, sessionStatus } from '@shared/session';
import { allWindows, errored, notConnected, unsupported, type Measurement } from '@shared/window';
import { refreshSessionViaCli } from '../cli';
import type { AccountScope } from '../scope';
import { fetchProfile, fetchUsageWindows, type AnthropicRequestContext } from './anthropic-usage';
import type { AccountIdentity, ProbeContext, ProbeResult, ProviderAdapter } from './types';

const PRODUCT_NAME = 'OpenCode';
const REAUTH_HINT = 'Run `opencode auth login` and sign in again.';

/** Provider keys OpenCode uses, and how to name them to a human. */
const PROVIDER_NAMES: Readonly<Record<string, string>> = {
  anthropic: 'Claude Pro/Max',
  openai: 'ChatGPT Plus/Pro',
  'github-copilot': 'GitHub Copilot',
};

function providerName(key: string): string {
  return PROVIDER_NAMES[key] ?? key;
}

/** An OAuth entry — the only kind that represents a subscription. */
const OAuthEntrySchema = z.object({
  type: z.literal('oauth'),
  access: z.string().optional().nullable(),
  refresh: z.string().optional().nullable(),
  expires: z.number().optional().nullable(),
  accountId: z.string().optional().nullable(),
});

/**
 * Key-based entries. Recognised so they can be reported as excluded rather than dropped.
 *
 * `wellknown` used to fall through the classifier entirely, which meant such a login was
 * neither tracked nor mentioned — it simply never appeared, with nothing to explain why.
 */
const KeyEntrySchema = z.object({
  type: z.union([z.literal('api'), z.literal('wellknown')]),
});

const AuthFileSchema = z.record(z.string(), z.unknown());

export interface SubscriptionEntry {
  readonly providerKey: string;
  readonly accessToken: string | undefined;
  readonly expires: number | undefined;
  /** OpenCode records this for OAuth logins; it is the stable subject for the account. */
  readonly accountId: string | undefined;
}

export class OpenCodeAdapter implements ProviderAdapter {
  readonly provider = 'opencode' as const;

  /**
   * Where OpenCode keeps `auth.json`.
   *
   * Verified against the installed CLI: `XDG_DATA_HOME` is honoured and `OPENCODE_DATA` is
   * not, so only the former is consulted. Both candidates are returned and the collector
   * probes them in order, which finds the file wherever it actually is instead of assuming.
   */
  defaultConfigDirs(): readonly string[] {
    const xdg = process.env['XDG_DATA_HOME'];
    const platformDefault =
      process.platform === 'win32'
        ? `${process.env['USERPROFILE'] ?? '~'}\\.local\\share\\opencode`
        : '~/.local/share/opencode';

    return xdg !== undefined && xdg.trim() !== ''
      ? [`${xdg}/opencode`, platformDefault]
      : [platformDefault];
  }

  async probe(scope: AccountScope, context: ProbeContext): Promise<ProbeResult> {
    const entries = await this.readEntries(scope, context);
    if (!entries.ok) return { identity: null, windows: allWindows(entries.measurement) };

    const { subscriptions, keyOnlyProviders } = entries;
    if (subscriptions.length === 0) {
      return { identity: null, windows: allWindows(describeNoSubscription(keyOnlyProviders)) };
    }

    // Anthropic first: it is the one subscription whose usage this project can read.
    const anthropic = subscriptions.find((entry) => entry.providerKey === 'anthropic');
    if (anthropic?.accessToken != null) {
      return this.probeAnthropic(anthropic, scope, context);
    }

    return {
      identity: this.identityFor(subscriptions, scope),
      windows: allWindows(describeUnreadable(subscriptions)),
    };
  }

  /** Reads and classifies auth.json, refreshing first if the session has expired. */
  private async readEntries(
    scope: AccountScope,
    context: ProbeContext,
  ): Promise<
    | { ok: true; subscriptions: SubscriptionEntry[]; keyOnlyProviders: string[] }
    | { ok: false; measurement: Measurement }
  > {
    const first = await this.loadAuthFile(scope);
    if (!first.ok) return first;

    // Every OAuth entry carries its expiry, so a stale session can be refreshed by the
    // official client before it is used, exactly as the Claude adapter does.
    const stale = first.subscriptions.some(
      (entry) => entry.accessToken != null && needsRefresh(sessionStatus(entry.expires ?? undefined, context.now)),
    );
    if (!stale) return first;

    context.logger.info('OpenCode session is expiring; asking the client to refresh');
    if (!(await refreshSessionViaCli('opencode', context.logger))) return first;

    const second = await this.loadAuthFile(scope);
    return second.ok ? second : first;
  }

  private async loadAuthFile(
    scope: AccountScope,
  ): Promise<
    | { ok: true; subscriptions: SubscriptionEntry[]; keyOnlyProviders: string[] }
    | { ok: false; measurement: Measurement }
  > {
    const raw = await scope.readJson('auth.json');
    if (raw === undefined) {
      // No file is the normal "not signed in" state; the directory itself may not exist yet.
      return {
        ok: false,
        measurement: notConnected(
          'no OpenCode logins',
          'Press Sign in, or run `opencode auth login` and choose a subscription.',
        ),
      };
    }
    if (!raw.ok) {
      return { ok: false, measurement: errored('OpenCode auth file is unreadable', raw.reason) };
    }

    const parsed = AuthFileSchema.safeParse(raw.value);
    if (!parsed.success) {
      return {
        ok: false,
        measurement: errored(
          'OpenCode auth file has an unexpected shape',
          'Expected an object keyed by provider.',
        ),
      };
    }

    return { ok: true, ...classifyEntries(parsed.data) };
  }

  private async probeAnthropic(
    entry: SubscriptionEntry,
    scope: AccountScope,
    context: ProbeContext,
  ): Promise<ProbeResult> {
    const accessToken = entry.accessToken as string;
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
      return { identity: this.identityFor([entry], scope), windows };
    }

    // The same Anthropic account a Claude row would report, so the quota is one pool.
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
   * Builds an identity from what the login itself records.
   *
   * OpenCode stores an `accountId` on OAuth entries, which is a real subject: it survives
   * moving the data directory. Only when an entry carries none does this fall back to a
   * digest of the directory, which is weaker — a moved directory mints a new id — and so is
   * a last resort rather than the normal path.
   */
  private identityFor(entries: readonly SubscriptionEntry[], scope: AccountScope): AccountIdentity {
    const named = entries.map((entry) => providerName(entry.providerKey));
    const withAccount = entries.find((entry) => entry.accountId != null);

    const subject =
      withAccount?.accountId != null
        ? `${withAccount.providerKey}:${withAccount.accountId}`
        : `dir:${createHash('sha256').update(scope.root).digest('hex').slice(0, 12)}`;

    return {
      id: makeAccountId('opencode', subject),
      subject: withAccount?.accountId == null ? {} : { accountUuid: withAccount.accountId },
      label: 'OpenCode',
      subtitle: named.length > 0 ? named.join(', ') : scope.root,
    };
  }
}

export interface ClassifiedEntries {
  readonly subscriptions: SubscriptionEntry[];
  /** Providers configured with a key rather than a subscription, so they can be named. */
  readonly keyOnlyProviders: string[];
}

/** Exported for tests: splits an auth file into subscription logins and key-based ones. */
export function classifyEntries(file: Record<string, unknown>): ClassifiedEntries {
  const subscriptions: SubscriptionEntry[] = [];
  const keyOnlyProviders: string[] = [];

  for (const [providerKey, value] of Object.entries(file)) {
    const oauth = OAuthEntrySchema.safeParse(value);
    if (oauth.success) {
      subscriptions.push({
        providerKey,
        accessToken: oauth.data.access ?? undefined,
        expires: oauth.data.expires ?? undefined,
        accountId: oauth.data.accountId ?? undefined,
      });
      continue;
    }
    if (KeyEntrySchema.safeParse(value).success) {
      keyOnlyProviders.push(providerKey);
    }
  }

  return { subscriptions, keyOnlyProviders };
}

function describeNoSubscription(keyOnlyProviders: readonly string[]): Measurement {
  if (keyOnlyProviders.length === 0) {
    return notConnected(
      'no OpenCode subscription logins',
      'Press Sign in, or run `opencode auth login` and choose a subscription.',
    );
  }
  // API keys are metered accounts with no windows, and are out of scope by design.
  return notConnected(
    'OpenCode is using API keys only',
    `Excluded: ${keyOnlyProviders.map(providerName).join(', ')}. This monitor tracks subscriptions only.`,
  );
}

function describeUnreadable(entries: readonly SubscriptionEntry[]): Measurement {
  const names = entries.map((entry) => providerName(entry.providerKey));
  return unsupported(
    `no readable usage for ${names.join(', ')}`,
    'Only a Claude subscription reports usage this app can read. The others publish no verified usage endpoint, so no figure is shown rather than a guessed one.',
  );
}
