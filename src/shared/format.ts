/** Presentation helpers shared by the UI and by adapters that build `detail` strings. */

/** `2` -> "2%", `2.4` -> "2.4%". Whole numbers stay whole so the column stays scannable. */
export function formatPercent(percent: number): string {
  const rounded = Math.round(percent * 10) / 10;
  return Number.isInteger(rounded) ? `${rounded}%` : `${rounded.toFixed(1)}%`;
}

/** Formats a minor-unit amount, e.g. 5598 USD with exponent 2 -> "$55.98". */
export function formatMoney(amountMinor: number, currency: string, exponent: number): string {
  const amount = amountMinor / 10 ** exponent;
  try {
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency,
      minimumFractionDigits: exponent,
      maximumFractionDigits: exponent,
    }).format(amount);
  } catch {
    // An unrecognised currency code should not blank out an otherwise valid figure.
    return `${amount.toFixed(exponent)} ${currency}`;
  }
}

function formatDurationMs(ms: number): string {
  const totalMinutes = Math.floor(ms / 60_000);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;

  if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  if (totalMinutes > 0) return `${totalMinutes}m`;
  return 'under a minute';
}

/** "resets in 4h 58m", or "reset pending" once the instant has passed but the provider has not caught up. */
export function formatReset(resetsAt: string, now: Date = new Date()): string | undefined {
  const target = Date.parse(resetsAt);
  if (Number.isNaN(target)) return undefined;
  const remaining = target - now.getTime();
  if (remaining <= 0) return 'reset pending';
  return `resets in ${formatDurationMs(remaining)}`;
}

/** "12s ago" / "3m ago". Used for both the poll clock and the age of a cached snapshot. */
export function formatAgo(iso: string, now: Date = new Date()): string | undefined {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return undefined;
  const elapsed = now.getTime() - then;
  if (elapsed < 0) return 'just now';
  if (elapsed < 60_000) return `${Math.floor(elapsed / 1000)}s ago`;
  return `${formatDurationMs(elapsed)} ago`;
}
