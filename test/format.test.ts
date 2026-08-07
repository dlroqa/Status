import { describe, expect, it } from 'vitest';
import { formatAgo, formatMoney, formatPercent, formatReset } from '@shared/format';

const NOW = new Date('2026-08-07T18:00:00.000Z');

describe('formatPercent', () => {
  it('keeps whole numbers whole and shows one decimal otherwise', () => {
    expect(formatPercent(2)).toBe('2%');
    expect(formatPercent(2.04)).toBe('2%');
    expect(formatPercent(2.44)).toBe('2.4%');
  });
});

describe('formatMoney', () => {
  it('renders minor units using the reported exponent', () => {
    expect(formatMoney(5598, 'USD', 2)).toContain('55.98');
  });

  it('still shows the figure when the currency code is unknown', () => {
    expect(formatMoney(1000, 'XYZ', 2)).toContain('10.00');
  });
});

describe('formatReset', () => {
  it('describes time remaining', () => {
    expect(formatReset('2026-08-07T22:58:00.000Z', NOW)).toBe('resets in 4h 58m');
    expect(formatReset('2026-08-13T18:00:00.000Z', NOW)).toBe('resets in 6d');
  });

  it('marks an elapsed reset as pending rather than showing a negative duration', () => {
    expect(formatReset('2026-08-07T17:00:00.000Z', NOW)).toBe('reset pending');
  });

  it('returns nothing for an unparseable instant', () => {
    expect(formatReset('not a date', NOW)).toBeUndefined();
  });
});

describe('formatAgo', () => {
  it('counts seconds under a minute and coarser units above', () => {
    expect(formatAgo('2026-08-07T17:59:48.000Z', NOW)).toBe('12s ago');
    expect(formatAgo('2026-08-07T15:30:00.000Z', NOW)).toBe('2h 30m ago');
  });

  it('handles a future timestamp from clock skew without showing a negative age', () => {
    expect(formatAgo('2026-08-07T18:00:05.000Z', NOW)).toBe('just now');
  });
});
