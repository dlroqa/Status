import { describe, expect, it } from 'vitest';
import { UsageSchema, mapUsage } from '@main/providers/anthropic-usage';
import { isLive } from '@shared/window';
import liveResponse from './fixtures/anthropic-usage.json';

const NOW = new Date('2026-08-07T18:31:00.000Z');

function parse(body: unknown) {
  const result = UsageSchema.safeParse(body);
  if (!result.success) throw new Error(result.error.message);
  return result.data;
}

describe('mapUsage', () => {
  it('maps a real captured response onto the rolling windows', () => {
    const windows = mapUsage(parse(liveResponse), NOW);

    const fiveHour = windows['5h'];
    expect(fiveHour.state).toBe('live');
    if (!isLive(fiveHour)) throw new Error('expected live');
    expect(fiveHour.percent).toBe(2);
    expect(fiveHour.resetsAt).toBe('2026-08-07T23:30:00.897288+00:00');

    const weekly = windows.weekly;
    if (!isLive(weekly)) throw new Error('expected live');
    expect(weekly.percent).toBe(2);
    expect(weekly.resetsAt).toBe('2026-08-13T23:00:00.897304+00:00');
  });

  it('reports spend as text when no monthly cap is set, never a fabricated percentage', () => {
    const monthly = mapUsage(parse(liveResponse), NOW).monthly;

    expect(monthly.state).toBe('unavailable');
    expect(isLive(monthly)).toBe(false);
    if (monthly.state !== 'unavailable') throw new Error('expected unavailable');
    expect(monthly.reason).toContain('no monthly spend cap');
    expect(monthly.detail).toContain('55.98');
  });

  it('computes a real percentage once a monthly cap exists', () => {
    const withCap = parse({
      ...liveResponse,
      extra_usage: { ...liveResponse.extra_usage, monthly_limit: 10_000 },
    });

    const monthly = mapUsage(withCap, NOW).monthly;
    if (!isLive(monthly)) throw new Error('expected live');
    expect(monthly.percent).toBeCloseTo(55.98, 5);
    expect(monthly.detail).toContain('of');
  });

  it('marks a missing window unavailable rather than zero', () => {
    const windows = mapUsage(parse({ ...liveResponse, five_hour: null }), NOW);
    expect(windows['5h'].state).toBe('unavailable');
    expect(isLive(windows['5h'])).toBe(false);
  });

  it('reports extra usage as unsupported when the account has it turned off', () => {
    const windows = mapUsage(
      parse({ ...liveResponse, extra_usage: { ...liveResponse.extra_usage, is_enabled: false } }),
      NOW,
    );
    expect(windows.monthly.state).toBe('unsupported');
  });

  it('clamps an over-limit utilisation', () => {
    const windows = mapUsage(parse({ ...liveResponse, five_hour: { utilization: 105.4 } }), NOW);
    const fiveHour = windows['5h'];
    if (!isLive(fiveHour)) throw new Error('expected live');
    expect(fiveHour.percent).toBe(100);
  });
});

describe('monthly cap', () => {
  it('uses the user-configured cap when the provider reports none, and labels it as theirs', () => {
    const monthly = mapUsage(parse(liveResponse), NOW, 10_000).monthly;

    if (!isLive(monthly)) throw new Error('expected live');
    expect(monthly.percent).toBeCloseTo(55.98, 5);
    // A self-imposed budget must not read as a limit the provider enforces.
    expect(monthly.source).toBe('your monthly cap');
  });

  it("prefers the provider's own cap over the user's", () => {
    const withProviderCap = parse({
      ...liveResponse,
      extra_usage: { ...liveResponse.extra_usage, monthly_limit: 20_000 },
    });

    const monthly = mapUsage(withProviderCap, NOW, 10_000).monthly;
    if (!isLive(monthly)) throw new Error('expected live');
    expect(monthly.percent).toBeCloseTo(27.99, 5);
    expect(monthly.source).toBe('anthropic extra usage');
  });

  it('stays barless when neither the provider nor the user set a cap', () => {
    const monthly = mapUsage(parse(liveResponse), NOW, undefined).monthly;
    expect(monthly.state).toBe('unavailable');
  });
});
