/**
 * ChatGPT (Codex CLI subscription) adapter.
 *
 * Codex records the rate-limit snapshot the ChatGPT backend returns into its own session
 * logs. Those snapshots are the provider's own numbers, so this adapter reads them rather
 * than estimating anything locally.
 *
 * The shapes below follow the upstream definitions in
 * `codex-rs/protocol/src/protocol.rs` (RateLimitSnapshot / RateLimitWindow /
 * CreditsSnapshot / TokenCountEvent).
 *
 * Two upstream realities are handled explicitly rather than papered over:
 *
 *  1. Recent Codex builds frequently write `rate_limits: null` (openai/codex#14880). When
 *     no snapshot exists the row says so instead of showing a misleading empty bar.
 *  2. The reset field changed shape. Current builds emit `resets_at` (epoch seconds);
 *     older ones emitted `resets_in_seconds`. Both are parsed, discriminated by presence.
 *
 * Snapshots can also lag reality by hours, so every value carries the time it was observed
 * and the UI shows that age.
 */

import { z } from 'zod';
import { makeAccountId } from '@shared/account';
import { clampPercent } from '@shared/severity';
import {
  allWindows,
  errored,
  live,
  notConnected,
  unavailable,
  unsupported,
  type Measurement,
  type WindowKind,
} from '@shared/window';
import type { AccountScope } from '../scope';
import type { AccountIdentity, ProbeContext, ProbeResult, ProviderAdapter } from './types';

const SOURCE = 'codex session snapshot';
/** Newest sessions only: older files cannot hold a fresher snapshot. */
const MAX_SESSION_FILES_SCANNED = 12;
/** Snapshots sit near the end of a session log; reading the tail avoids loading huge files. */
const SESSION_TAIL_BYTES = 512 * 1024;
/** Below one day is treated as the short (5-hour class) window, at or above it as the long one. */
const SHORT_WINDOW_MAX_MINUTES = 1440;

const RateLimitWindowSchema = z.object({
  used_percent: z.number(),
  window_minutes: z.number().optional().nullable(),
  resets_at: z.number().optional().nullable(),
  resets_in_seconds: z.number().optional().nullable(),
});

const CreditsSchema = z.object({
  has_credits: z.boolean().optional().nullable(),
  unlimited: z.boolean().optional().nullable(),
  balance: z.string().optional().nullable(),
});

const RateLimitSnapshotSchema = z.object({
  primary: RateLimitWindowSchema.optional().nullable(),
  secondary: RateLimitWindowSchema.optional().nullable(),
  credits: CreditsSchema.optional().nullable(),
  plan_type: z.string().optional().nullable(),
});

export type RateLimitSnapshot = z.infer<typeof RateLimitSnapshotSchema>;
type RateLimitWindow = z.infer<typeof RateLimitWindowSchema>;

/**
 * Codex auth.json. Only the fields this app needs are described, and all of them are
 * optional: the file's full shape is not part of any published contract, so the adapter
 * degrades to a clear message rather than failing when a field is absent.
 */
const AuthSchema = z.object({
  OPENAI_API_KEY: z.string().nullish(),
  tokens: z
    .object({
      id_token: z.string().optional().nullable(),
      access_token: z.string().optional().nullable(),
      account_id: z.string().optional().nullable(),
    })
    .optional()
    .nullable(),
});

export class CodexAdapter implements ProviderAdapter {
  readonly provider = 'chatgpt' as const;

  defaultConfigDirs(): readonly string[] {
    const fromEnv = process.env['CODEX_HOME'];
    return fromEnv !== undefined && fromEnv.trim() !== '' ? [fromEnv, '~/.codex'] : ['~/.codex'];
  }

  async probe(scope: AccountScope, context: ProbeContext): Promise<ProbeResult> {
    if (!(await scope.exists())) {
      return {
        identity: null,
        windows: allWindows(notConnected('no Codex directory', `Looked in ${scope.root}`)),
      };
    }

    const auth = await this.readIdentity(scope);
    if (!auth.ok) {
      return { identity: null, windows: allWindows(auth.measurement) };
    }

    const found = await findLatestSnapshot(scope, context);
    if (found.snapshot === undefined) {
      return { identity: auth.identity, windows: allWindows(describeMissingSnapshot(found.sessionsSeen)) };
    }

    return { identity: auth.identity, windows: mapSnapshot(found.snapshot.snapshot, found.snapshot.observedAt) };
  }

  private async readIdentity(
    scope: AccountScope,
  ): Promise<{ ok: true; identity: AccountIdentity } | { ok: false; measurement: Measurement }> {
    const raw = await scope.readJson('auth.json');
    if (raw === undefined) {
      return {
        ok: false,
        measurement: notConnected(
          'not signed in to Codex',
          'Run `codex login` and choose ChatGPT sign-in.',
        ),
      };
    }
    if (!raw.ok) {
      return { ok: false, measurement: errored('Codex auth file is unreadable', raw.reason) };
    }

    const parsed = AuthSchema.safeParse(raw.value);
    if (!parsed.success) {
      return {
        ok: false,
        measurement: errored('Codex auth file has an unexpected shape', parsed.error.message),
      };
    }

    const tokens = parsed.data.tokens ?? undefined;
    const hasSubscription = Boolean(tokens?.id_token ?? tokens?.access_token ?? tokens?.account_id);

    if (!hasSubscription) {
      // An API key is a metered account, not a subscription, and has no usage windows.
      const reason =
        parsed.data.OPENAI_API_KEY != null
          ? 'Codex is using an API key'
          : 'no ChatGPT subscription session in Codex';
      return {
        ok: false,
        measurement: notConnected(
          reason,
          'This monitor tracks subscriptions only. Run `codex login` and choose ChatGPT sign-in.',
        ),
      };
    }

    const claims = tokens?.id_token != null ? decodeJwtClaims(tokens.id_token) : undefined;
    const subject =
      (tokens?.account_id ?? undefined) ??
      stringClaim(claims, 'chatgpt_account_id') ??
      stringClaim(claims, 'sub');
    const email = stringClaim(claims, 'email');
    const plan = stringClaim(claims, 'chatgpt_plan_type');

    if (subject === undefined) {
      // Without a subject there is no way to tell two ChatGPT accounts apart, and pooling
      // them under one id would attach one account's bar to another's data.
      return {
        ok: false,
        measurement: errored(
          'Codex session carries no account identity',
          'Sign out and run `codex login` again to refresh the session.',
        ),
      };
    }

    return {
      ok: true,
      identity: {
        id: makeAccountId('chatgpt', subject),
        subject: { accountUuid: subject, ...(email === undefined ? {} : { email }) },
        label: email ?? 'ChatGPT account',
        ...(plan === undefined ? {} : { plan: titleCase(plan) }),
        ...(email === undefined ? {} : { subtitle: email }),
      },
    };
  }
}

interface FoundSnapshot {
  readonly snapshot: RateLimitSnapshot;
  /** ISO-8601 instant the snapshot was recorded — may be well before now. */
  readonly observedAt: string;
}

/**
 * Explains an absent snapshot.
 *
 * Signing in and never using Codex is not the same failure as Codex declining to log its
 * limits, and they need different things from the user. Reporting a known upstream bug to
 * someone who simply has not run the tool yet would send them chasing nothing.
 */
function describeMissingSnapshot(sessionsSeen: boolean): Measurement {
  if (!sessionsSeen) {
    return unavailable('no usage recorded yet', {
      detail:
        'Codex reports its limits as it works, so figures appear after it has run. If your ChatGPT plan does not include Codex, there are no limits to show.',
    });
  }
  return unavailable('Codex reported no limits', {
    detail:
      'Codex has run but logged no limit figures. That is expected on a plan without a Codex allowance, and also happens on some Codex builds (openai/codex#14880).',
  });
}

interface SnapshotSearch {
  readonly snapshot: FoundSnapshot | undefined;
  /** True when Codex has session logs at all, which distinguishes "unused" from "not logged". */
  readonly sessionsSeen: boolean;
}

/** Scans the newest session logs backwards for the most recent non-null rate-limit snapshot. */
async function findLatestSnapshot(
  scope: AccountScope,
  context: ProbeContext,
): Promise<SnapshotSearch> {
  const files = await scope.listFiles('sessions', { extension: '.jsonl' });
  if (files.length === 0) return { snapshot: undefined, sessionsSeen: false };

  const withTimes = await Promise.all(
    files.map(async (file) => ({ file, mtime: (await scope.modifiedAt(file)) ?? 0 })),
  );
  withTimes.sort((a, b) => b.mtime - a.mtime);

  for (const { file, mtime } of withTimes.slice(0, MAX_SESSION_FILES_SCANNED)) {
    const text = await scope.readTailText(file, SESSION_TAIL_BYTES);
    if (text === undefined) continue;

    const found = scanLinesForSnapshot(text, mtime, context);
    if (found !== undefined) return { snapshot: found, sessionsSeen: true };
  }
  return { snapshot: undefined, sessionsSeen: true };
}

/** Exported for tests: finds the last snapshot in a chunk of JSONL. */
export function scanLinesForSnapshot(
  text: string,
  fallbackMtimeMs: number,
  context?: Pick<ProbeContext, 'logger'>,
): FoundSnapshot | undefined {
  const lines = text.split('\n');
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]?.trim();
    if (line === undefined || line.length === 0 || !line.startsWith('{')) continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      // Expected for the first line when reading a tail, and for any partially-written line.
      continue;
    }

    const record = parsed as Record<string, unknown>;
    // Current format nests the event under `payload`; older records were flat.
    const payload =
      isRecord(record['payload']) ? (record['payload'] as Record<string, unknown>) : record;
    if (payload['type'] !== 'token_count') continue;

    const rateLimits = payload['rate_limits'];
    if (rateLimits == null) continue; // The documented null case: keep looking further back.

    const snapshot = RateLimitSnapshotSchema.safeParse(rateLimits);
    if (!snapshot.success) {
      context?.logger.warn('unrecognised codex rate_limits shape:', snapshot.error.message);
      continue;
    }

    const timestamp = typeof record['timestamp'] === 'string' ? Date.parse(record['timestamp']) : NaN;
    const observedAt = new Date(Number.isNaN(timestamp) ? fallbackMtimeMs : timestamp).toISOString();
    return { snapshot: snapshot.data, observedAt };
  }
  return undefined;
}

/** Exported for tests: maps a snapshot onto the three windows. */
export function mapSnapshot(
  snapshot: RateLimitSnapshot,
  observedAt: string,
): Record<WindowKind, Measurement> {
  const primary = snapshot.primary ?? undefined;
  const secondary = snapshot.secondary ?? undefined;

  // Prefer classifying by the window's own declared length: a plan change can swap which
  // slot holds which window, and mapping by position would then mislabel both bars.
  const classified = classifyWindows(primary, secondary);

  return {
    '5h': measureWindow(classified.short, observedAt, '5-hour'),
    weekly: measureWindow(classified.long, observedAt, 'weekly'),
    monthly: measureCredits(snapshot.credits ?? undefined),
  };
}

interface ClassifiedWindow {
  readonly window: RateLimitWindow;
  /** True when the slot was inferred from position because no length was reported. */
  readonly positional: boolean;
}

function classifyWindows(
  primary: RateLimitWindow | undefined,
  secondary: RateLimitWindow | undefined,
): { short?: ClassifiedWindow; long?: ClassifiedWindow } {
  const result: { short?: ClassifiedWindow; long?: ClassifiedWindow } = {};

  for (const window of [primary, secondary]) {
    if (window === undefined) continue;
    const minutes = window.window_minutes;
    if (minutes == null) continue;
    const slot = minutes < SHORT_WINDOW_MAX_MINUTES ? 'short' : 'long';
    if (result[slot] === undefined) result[slot] = { window, positional: false };
  }

  // Fall back to position only for windows that declared no length.
  if (result.short === undefined && primary !== undefined && primary.window_minutes == null) {
    result.short = { window: primary, positional: true };
  }
  if (result.long === undefined && secondary !== undefined && secondary.window_minutes == null) {
    result.long = { window: secondary, positional: true };
  }
  return result;
}

function measureWindow(
  classified: ClassifiedWindow | undefined,
  observedAt: string,
  name: string,
): Measurement {
  if (classified === undefined) {
    return unavailable(`Codex reported no ${name} window`, { observedAt });
  }

  const { window, positional } = classified;
  const resetsAt = resolveReset(window, observedAt);
  const minutes = window.window_minutes;
  const detailParts: string[] = [];
  if (minutes != null) detailParts.push(`${describeMinutes(minutes)} window`);
  if (positional) detailParts.push('slot inferred from position');

  return live({
    percent: clampPercent(window.used_percent),
    source: positional ? `${SOURCE} (positional mapping)` : SOURCE,
    observedAt,
    ...(resetsAt === undefined ? {} : { resetsAt }),
    ...(detailParts.length === 0 ? {} : { detail: detailParts.join(' · ') }),
  });
}

/** Handles both upstream reset encodings; `resets_in_seconds` is relative to the snapshot. */
function resolveReset(window: RateLimitWindow, observedAt: string): string | undefined {
  if (window.resets_at != null) {
    return new Date(window.resets_at * 1000).toISOString();
  }
  if (window.resets_in_seconds != null) {
    const base = Date.parse(observedAt);
    if (Number.isNaN(base)) return undefined;
    return new Date(base + window.resets_in_seconds * 1000).toISOString();
  }
  return undefined;
}

function measureCredits(credits: z.infer<typeof CreditsSchema> | undefined): Measurement {
  if (credits === undefined) {
    return unsupported('Codex reported no credit information');
  }
  if (credits.unlimited === true) {
    return unsupported('this plan includes unlimited credits');
  }
  if (credits.has_credits !== true) {
    return unsupported('no extra credits on this plan');
  }
  // A balance is not a consumed fraction, and there is no cap to divide by.
  return unavailable('credit balance has no monthly cap', {
    ...(credits.balance == null ? {} : { detail: `${credits.balance} remaining` }),
  });
}

function describeMinutes(minutes: number): string {
  if (minutes >= 1440) {
    const days = Math.round(minutes / 1440);
    return days === 7 ? 'weekly' : `${days}-day`;
  }
  const hours = Math.round(minutes / 60);
  return hours >= 1 ? `${hours}-hour` : `${minutes}-minute`;
}

/**
 * Reads claims out of a JWT without verifying it.
 *
 * Verification would need the issuer's keys and buys nothing here: the token came from the
 * user's own machine and is used only for display and for telling two accounts apart.
 */
function decodeJwtClaims(token: string): Record<string, unknown> | undefined {
  const parts = token.split('.');
  const payload = parts[1];
  if (parts.length !== 3 || payload === undefined) return undefined;
  try {
    const json = Buffer.from(payload, 'base64url').toString('utf8');
    const claims: unknown = JSON.parse(json);
    return isRecord(claims) ? claims : undefined;
  } catch {
    return undefined;
  }
}

function stringClaim(claims: Record<string, unknown> | undefined, key: string): string | undefined {
  if (claims === undefined) return undefined;
  const direct = claims[key];
  if (typeof direct === 'string' && direct.length > 0) return direct;

  // ChatGPT nests plan and account details under a namespaced auth claim.
  for (const value of Object.values(claims)) {
    if (isRecord(value)) {
      const nested = value[key];
      if (typeof nested === 'string' && nested.length > 0) return nested;
    }
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function titleCase(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
