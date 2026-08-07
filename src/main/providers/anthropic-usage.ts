/**
 * Anthropic subscription usage endpoints.
 *
 * Shared by the Claude adapter and by the OpenCode adapter, because an OpenCode profile
 * signed in with Claude Pro/Max holds the same kind of subscription session and its usage
 * is readable the same way. Keeping this in one module means both paths agree on how a
 * percentage, a reset time and a failure are derived.
 *
 * The schemas mirror a live 200 response captured from these endpoints.
 */

import { z } from 'zod';
import { formatMoney } from '@shared/format';
import { clampPercent } from '@shared/severity';
import {
  allWindows,
  errored,
  live,
  unavailable,
  unsupported,
  type Measurement,
  type WindowKind,
} from '@shared/window';
import { getJson, type HttpResult } from '../http';
import type { Logger } from '../logger';

export const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
export const PROFILE_URL = 'https://api.anthropic.com/api/oauth/profile';
const OAUTH_BETA = 'oauth-2025-04-20';
const SOURCE = 'anthropic /api/oauth/usage';

const WindowSchema = z.object({
  utilization: z.number(),
  resets_at: z.string().optional().nullable(),
});

const ExtraUsageSchema = z.object({
  is_enabled: z.boolean().optional().nullable(),
  monthly_limit: z.number().optional().nullable(),
  used_credits: z.number().optional().nullable(),
  currency: z.string().optional().nullable(),
  decimal_places: z.number().int().optional().nullable(),
});

export const UsageSchema = z.object({
  five_hour: WindowSchema.optional().nullable(),
  seven_day: WindowSchema.optional().nullable(),
  extra_usage: ExtraUsageSchema.optional().nullable(),
});

export type UsageResponse = z.infer<typeof UsageSchema>;

const ProfileSchema = z.object({
  account: z.object({
    uuid: z.string().min(1),
    email: z.string().optional().nullable(),
    display_name: z.string().optional().nullable(),
    full_name: z.string().optional().nullable(),
    has_claude_pro: z.boolean().optional().nullable(),
    has_claude_max: z.boolean().optional().nullable(),
  }),
  organization: z
    .object({
      uuid: z.string().optional().nullable(),
      organization_type: z.string().optional().nullable(),
    })
    .optional()
    .nullable(),
});

export interface AnthropicProfile {
  readonly accountUuid: string;
  readonly email?: string;
  readonly name?: string;
  readonly orgUuid?: string;
  readonly plan?: string;
}

export function authHeaders(accessToken: string): Record<string, string> {
  return { Authorization: `Bearer ${accessToken}`, 'anthropic-beta': OAUTH_BETA };
}

export interface AnthropicRequestContext {
  readonly now: Date;
  readonly logger: Logger;
  readonly signal?: AbortSignal;
  /** Named in failure messages so the user knows which session to fix. */
  readonly productName: string;
  /** What the user should run to re-authenticate, e.g. "Run `claude` and sign in again." */
  readonly reauthHint: string;
}

/** Fetches and maps the three windows, turning every failure into an actionable reason. */
export async function fetchUsageWindows(
  accessToken: string,
  context: AnthropicRequestContext,
): Promise<Record<WindowKind, Measurement>> {
  const response = await getJson(USAGE_URL, {
    headers: authHeaders(accessToken),
    ...(context.signal ? { signal: context.signal } : {}),
  });

  if (!response.ok) {
    return allWindows(httpFailureMeasurement(response, context));
  }

  const parsed = UsageSchema.safeParse(response.body);
  if (!parsed.success) {
    context.logger.warn('unexpected /api/oauth/usage shape:', parsed.error.message);
    return allWindows(
      errored('Anthropic returned an unrecognised usage format', 'The app may need an update.'),
    );
  }

  return mapUsage(parsed.data, context.now);
}

export async function fetchProfile(
  accessToken: string,
  context: AnthropicRequestContext,
): Promise<AnthropicProfile | undefined> {
  const response = await getJson(PROFILE_URL, {
    headers: authHeaders(accessToken),
    ...(context.signal ? { signal: context.signal } : {}),
  });
  if (!response.ok) {
    context.logger.warn(`could not read ${context.productName} profile:`, response.reason);
    return undefined;
  }

  const parsed = ProfileSchema.safeParse(response.body);
  if (!parsed.success) {
    context.logger.warn('unexpected /api/oauth/profile shape:', parsed.error.message);
    return undefined;
  }

  const { account, organization } = parsed.data;
  const email = account.email ?? undefined;
  const name = account.display_name ?? account.full_name ?? undefined;
  const plan = account.has_claude_max === true ? 'Max' : account.has_claude_pro === true ? 'Pro' : undefined;

  return {
    accountUuid: account.uuid,
    ...(email === undefined ? {} : { email }),
    ...(name === undefined ? {} : { name }),
    ...(organization?.uuid ? { orgUuid: organization.uuid } : {}),
    ...(plan === undefined ? {} : { plan }),
  };
}

/** Exported for tests: maps a parsed usage response onto the three windows. */
export function mapUsage(usage: UsageResponse, now: Date): Record<WindowKind, Measurement> {
  const observedAt = now.toISOString();
  return {
    '5h': mapRollingWindow(usage.five_hour, '5-hour', observedAt),
    weekly: mapRollingWindow(usage.seven_day, 'weekly', observedAt),
    monthly: mapExtraUsage(usage.extra_usage, observedAt),
  };
}

function mapRollingWindow(
  window: z.infer<typeof WindowSchema> | null | undefined,
  name: string,
  observedAt: string,
): Measurement {
  if (window === null || window === undefined) {
    return unavailable(`Anthropic reported no ${name} window`, { observedAt });
  }
  return live({
    percent: clampPercent(window.utilization),
    source: SOURCE,
    observedAt,
    ...(window.resets_at ? { resetsAt: window.resets_at } : {}),
  });
}

/**
 * The monthly row shows extra-usage credit spend.
 *
 * A subscription has no monthly token window, so this is real money rather than a quota.
 * When no monthly cap is configured there is no honest denominator, and inventing one
 * would put a reassuring green bar under an unbounded number — so the spend is reported
 * as text and the row stays barless until the user sets a cap.
 */
function mapExtraUsage(
  extra: z.infer<typeof ExtraUsageSchema> | null | undefined,
  observedAt: string,
): Measurement {
  if (extra === null || extra === undefined) {
    return unsupported('this plan has no extra-usage credits');
  }
  if (extra.is_enabled === false) {
    return unsupported('extra usage is turned off for this account');
  }

  const currency = extra.currency ?? 'USD';
  const exponent = extra.decimal_places ?? 2;
  const usedMinor = extra.used_credits ?? 0;
  const spent = formatMoney(usedMinor, currency, exponent);
  const limitMinor = extra.monthly_limit;

  if (limitMinor == null || limitMinor <= 0) {
    return unavailable('no monthly spend cap set', {
      detail: `${spent} used this month`,
      observedAt,
    });
  }

  return live({
    percent: clampPercent((usedMinor / limitMinor) * 100),
    source: 'anthropic extra usage',
    observedAt,
    detail: `${spent} of ${formatMoney(limitMinor, currency, exponent)}`,
  });
}

/** Turns a transport failure into a reason the user can act on. */
export function httpFailureMeasurement(
  result: Extract<HttpResult, { ok: false }>,
  context: Pick<AnthropicRequestContext, 'productName' | 'reauthHint'>,
): Measurement {
  switch (result.kind) {
    case 'unauthorized':
      return errored(`${context.productName} session expired`, context.reauthHint);
    case 'forbidden':
      return errored(
        `Anthropic refused this ${context.productName} session`,
        'The signed-in account may lack access to usage data.',
      );
    case 'rate-limited':
      return unavailable('Anthropic is rate-limiting usage checks', {
        detail: 'The next poll will retry.',
      });
    case 'timeout':
      return unavailable('Anthropic did not respond in time', { detail: result.reason });
    case 'network':
      return unavailable('could not reach Anthropic', { detail: result.reason });
    case 'parse':
      return errored('Anthropic returned an unreadable response', result.reason);
    case 'http':
      return errored('Anthropic rejected the usage request', result.reason);
  }
}
