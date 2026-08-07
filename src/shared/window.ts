/**
 * Usage windows and the measurement states a window can be in.
 *
 * The distinction between the non-live states matters: each one tells the user something
 * different about *why* there is no bar, and each has a different fix. Collapsing them
 * into a single "unknown" (or worse, into 0%) would hide actionable information.
 */

export const WINDOW_KINDS = ['5h', 'weekly', 'monthly'] as const;
export type WindowKind = (typeof WINDOW_KINDS)[number];

export const WINDOW_LABELS: Record<WindowKind, string> = {
  '5h': '5-hour',
  weekly: 'weekly',
  monthly: 'monthly',
};

/** A real, current number from the provider. The only state that renders a coloured bar. */
export interface LiveMeasurement {
  readonly state: 'live';
  /** 0-100, already clamped. */
  readonly percent: number;
  /** ISO-8601 instant the window resets, when the provider reports one. */
  readonly resetsAt?: string;
  /** ISO-8601 instant this number was true — may be older than fetchedAt for cached sources. */
  readonly observedAt: string;
  /** Provenance, e.g. "anthropic /api/oauth/usage". Shown in the UI on hover. */
  readonly source: string;
  /** Optional supporting text, e.g. a dollar figure behind the percentage. */
  readonly detail?: string;
}

/** The provider genuinely has no such window — nothing is broken and there is nothing to fix. */
export interface UnsupportedMeasurement {
  readonly state: 'unsupported';
  readonly reason: string;
  readonly detail?: string;
}

/** The window exists but no value could be read. Usually actionable. */
export interface UnavailableMeasurement {
  readonly state: 'unavailable';
  readonly reason: string;
  readonly detail?: string;
  readonly observedAt?: string;
}

/** No subscription session was found for this account. */
export interface NotConnectedMeasurement {
  readonly state: 'not-connected';
  readonly reason: string;
  readonly detail?: string;
}

/** Something failed: expired session, unreadable file, network error. */
export interface ErrorMeasurement {
  readonly state: 'error';
  readonly reason: string;
  readonly detail?: string;
}

export type Measurement =
  | LiveMeasurement
  | UnsupportedMeasurement
  | UnavailableMeasurement
  | NotConnectedMeasurement
  | ErrorMeasurement;

export type MeasurementState = Measurement['state'];

export function isLive(measurement: Measurement): measurement is LiveMeasurement {
  return measurement.state === 'live';
}

/**
 * Constructors exist so that optional fields are omitted rather than set to `undefined`.
 * The project compiles with exactOptionalPropertyTypes, which treats those as different.
 */

export function live(args: {
  percent: number;
  source: string;
  observedAt: string;
  resetsAt?: string | undefined;
  detail?: string | undefined;
}): LiveMeasurement {
  return {
    state: 'live',
    percent: args.percent,
    source: args.source,
    observedAt: args.observedAt,
    ...(args.resetsAt === undefined ? {} : { resetsAt: args.resetsAt }),
    ...(args.detail === undefined ? {} : { detail: args.detail }),
  };
}

export function unsupported(reason: string, detail?: string): UnsupportedMeasurement {
  return { state: 'unsupported', reason, ...(detail === undefined ? {} : { detail }) };
}

export function unavailable(
  reason: string,
  options: { detail?: string | undefined; observedAt?: string | undefined } = {},
): UnavailableMeasurement {
  return {
    state: 'unavailable',
    reason,
    ...(options.detail === undefined ? {} : { detail: options.detail }),
    ...(options.observedAt === undefined ? {} : { observedAt: options.observedAt }),
  };
}

export function notConnected(reason: string, detail?: string): NotConnectedMeasurement {
  return { state: 'not-connected', reason, ...(detail === undefined ? {} : { detail }) };
}

export function errored(reason: string, detail?: string): ErrorMeasurement {
  return { state: 'error', reason, ...(detail === undefined ? {} : { detail }) };
}

/** Builds a full window set where every window carries the same non-live state. */
export function allWindows(measurement: Measurement): Record<WindowKind, Measurement> {
  return { '5h': measurement, weekly: measurement, monthly: measurement };
}
