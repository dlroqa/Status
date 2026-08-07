/**
 * One progress bar, for exactly one window of exactly one account.
 *
 * The component takes a single Measurement and nothing else. It has no access to other
 * accounts and no fallback value to borrow, so it cannot render another account's number.
 *
 * Colour is never the only signal: the percentage is always shown as text, the severity is
 * announced through aria-valuetext, and unmeasurable states are hatched rather than empty.
 */

import { SEVERITY_LABELS, severityFor } from '@shared/severity';
import { formatPercent } from '@shared/format';
import { isLive, type Measurement } from '@shared/window';
import { SEVERITY_THRESHOLDS } from '@shared/severity';

interface UsageBarProps {
  readonly measurement: Measurement;
  /** Announced to screen readers, e.g. "5-hour window for Claude". */
  readonly label: string;
}

export function UsageBar({ measurement, label }: UsageBarProps): React.ReactElement {
  if (!isLive(measurement)) {
    return (
      <div
        className="bar bar--unknown"
        role="img"
        aria-label={`${label}: no reading — ${measurement.reason}`}
        title={measurement.reason}
      />
    );
  }

  const severity = severityFor(measurement.percent);
  const valueText = `${formatPercent(measurement.percent)} used, ${SEVERITY_LABELS[severity]}`;

  return (
    <div
      className="bar"
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(measurement.percent)}
      aria-valuetext={valueText}
      aria-label={label}
      title={`${valueText} · ${measurement.source}`}
    >
      {/* Where the colour changes, so the bar is readable as a scale rather than a blob. */}
      <span className="bar__threshold" style={{ left: `${SEVERITY_THRESHOLDS.elevated}%` }} aria-hidden="true" />
      <span className="bar__threshold" style={{ left: `${SEVERITY_THRESHOLDS.critical}%` }} aria-hidden="true" />
      <span
        className={`bar__fill bar__fill--${severity}`}
        style={{ transform: `scaleX(${measurement.percent / 100})` }}
      />
    </div>
  );
}
