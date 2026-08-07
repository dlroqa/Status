import { describe, expect, it } from 'vitest';
import { SEVERITY_THRESHOLDS, clampPercent, severityFor } from '@shared/severity';

describe('severityFor', () => {
  it('is green below 50', () => {
    expect(severityFor(0)).toBe('normal');
    expect(severityFor(49)).toBe('normal');
    expect(severityFor(49.9)).toBe('normal');
  });

  it('turns amber at exactly 50', () => {
    expect(severityFor(SEVERITY_THRESHOLDS.elevated)).toBe('elevated');
    expect(severityFor(50)).toBe('elevated');
    expect(severityFor(84.9)).toBe('elevated');
  });

  it('turns red at exactly 85', () => {
    expect(severityFor(SEVERITY_THRESHOLDS.critical)).toBe('critical');
    expect(severityFor(85)).toBe('critical');
    expect(severityFor(100)).toBe('critical');
  });

  it('treats an over-limit value as critical rather than overflowing the track', () => {
    expect(severityFor(140)).toBe('critical');
    expect(clampPercent(140)).toBe(100);
  });

  it('clamps a negative value to zero', () => {
    expect(clampPercent(-5)).toBe(0);
    expect(severityFor(-5)).toBe('normal');
  });

  it('refuses a non-finite value instead of silently reporting zero', () => {
    // A zero bar reads as "plenty left"; that must never be the result of bad input.
    expect(() => clampPercent(Number.NaN)).toThrow(TypeError);
    expect(() => clampPercent(Number.POSITIVE_INFINITY)).toThrow(TypeError);
  });
});
