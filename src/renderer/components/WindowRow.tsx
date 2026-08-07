/**
 * One window row: label, bar, value, and — when there is no reading — the reason why.
 *
 * The reason is shown inline rather than hidden in a tooltip, because every non-live state
 * has a different fix and the user cannot act on what they cannot see.
 */

import { formatAgo, formatPercent, formatReset } from '@shared/format';
import { isLive, WINDOW_LABELS, type Measurement, type WindowKind } from '@shared/window';
import { UsageBar } from './UsageBar';

interface WindowRowProps {
  readonly kind: WindowKind;
  readonly measurement: Measurement;
  readonly accountLabel: string;
  readonly now: Date;
}

export function WindowRow({ kind, measurement, accountLabel, now }: WindowRowProps): React.ReactElement {
  const label = WINDOW_LABELS[kind];
  const meta = describeMeta(measurement, now);

  return (
    <div className="window">
      <span className="window__label">{label}</span>
      <UsageBar measurement={measurement} label={`${label} window for ${accountLabel}`} />
      {isLive(measurement) ? (
        <span className="window__value mono">{formatPercent(measurement.percent)}</span>
      ) : (
        <span className="window__value window__value--muted" aria-hidden="true">
          —
        </span>
      )}
      {meta !== undefined && (
        <span className="window__meta">
          <span className="window__reason">{meta}</span>
        </span>
      )}
    </div>
  );
}

/**
 * Builds the secondary line.
 *
 * For a live value that is the reset time, plus the observation age when the number is not
 * fresh — a Codex snapshot can be hours old, and a stale figure presented as current would
 * be misleading.
 */
function describeMeta(measurement: Measurement, now: Date): string | undefined {
  if (isLive(measurement)) {
    const parts: string[] = [];
    const reset = measurement.resetsAt === undefined ? undefined : formatReset(measurement.resetsAt, now);
    if (reset !== undefined) parts.push(reset);
    if (measurement.detail !== undefined) parts.push(measurement.detail);

    const age = now.getTime() - Date.parse(measurement.observedAt);
    if (Number.isFinite(age) && age > 5 * 60 * 1000) {
      const ago = formatAgo(measurement.observedAt, now);
      if (ago !== undefined) parts.push(`measured ${ago}`);
    }
    return parts.length > 0 ? parts.join(' · ') : undefined;
  }

  return measurement.detail === undefined
    ? measurement.reason
    : `${measurement.reason} — ${measurement.detail}`;
}
