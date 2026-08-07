/**
 * The colour rule for every progress bar in the app, defined exactly once.
 *
 * Green from 0, amber from 50%, red from 85% — thresholds inclusive at the boundary,
 * so exactly 50 is amber and exactly 85 is red.
 */

export type Severity = 'normal' | 'elevated' | 'critical';

export const SEVERITY_THRESHOLDS = {
  /** At or above this percent the bar is amber. */
  elevated: 50,
  /** At or above this percent the bar is red. */
  critical: 85,
} as const;

/**
 * Constrains a percentage to 0-100.
 *
 * Providers occasionally report slightly over 100 once a window is exhausted, and a bar
 * wider than its track would break the layout. Non-finite input is a programming error
 * rather than a value to paper over, so it throws instead of silently becoming zero —
 * a zero would read as "plenty left" when the truth is "we do not know".
 */
export function clampPercent(percent: number): number {
  if (!Number.isFinite(percent)) {
    throw new TypeError(`percent must be a finite number, received ${String(percent)}`);
  }
  return Math.min(100, Math.max(0, percent));
}

export function severityFor(percent: number): Severity {
  const value = clampPercent(percent);
  if (value >= SEVERITY_THRESHOLDS.critical) return 'critical';
  if (value >= SEVERITY_THRESHOLDS.elevated) return 'elevated';
  return 'normal';
}

/** Human-readable severity, used for screen readers and tooltips so colour is never the only signal. */
export const SEVERITY_LABELS: Record<Severity, string> = {
  normal: 'normal',
  elevated: 'elevated',
  critical: 'critical',
};
