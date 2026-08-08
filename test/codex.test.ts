import { describe, expect, it } from 'vitest';
import { mapSnapshot, scanLinesForSnapshot } from '@main/providers/codex';
import { isLive } from '@shared/window';

const OBSERVED = '2026-08-07T18:00:00.000Z';

describe('mapSnapshot', () => {
  it('classifies windows by their declared length, not by slot position', () => {
    // Slots deliberately swapped: the weekly window is in `primary`.
    const windows = mapSnapshot(
      {
        primary: { used_percent: 22, window_minutes: 10_079, resets_at: null, resets_in_seconds: null },
        secondary: { used_percent: 68, window_minutes: 299, resets_at: null, resets_in_seconds: null },
      },
      OBSERVED,
    );

    const fiveHour = windows['5h'];
    const weekly = windows.weekly;
    if (!isLive(fiveHour) || !isLive(weekly)) throw new Error('expected live');
    expect(fiveHour.percent).toBe(68);
    expect(weekly.percent).toBe(22);
  });

  it('falls back to slot position only when no window length is reported, and says so', () => {
    const windows = mapSnapshot(
      {
        primary: { used_percent: 10, window_minutes: null, resets_at: null, resets_in_seconds: null },
        secondary: { used_percent: 40, window_minutes: null, resets_at: null, resets_in_seconds: null },
      },
      OBSERVED,
    );

    const fiveHour = windows['5h'];
    if (!isLive(fiveHour)) throw new Error('expected live');
    expect(fiveHour.percent).toBe(10);
    expect(fiveHour.source).toContain('positional');
    expect(fiveHour.detail).toContain('position');
  });

  it('reads the current resets_at encoding as an absolute epoch', () => {
    const resetEpochSeconds = Math.floor(Date.parse('2026-08-07T23:00:00.000Z') / 1000);
    const windows = mapSnapshot(
      {
        primary: {
          used_percent: 5,
          window_minutes: 300,
          resets_at: resetEpochSeconds,
          resets_in_seconds: null,
        },
      },
      OBSERVED,
    );

    const fiveHour = windows['5h'];
    if (!isLive(fiveHour)) throw new Error('expected live');
    expect(fiveHour.resetsAt).toBe('2026-08-07T23:00:00.000Z');
  });

  it('reads the older resets_in_seconds encoding as relative to the snapshot', () => {
    const windows = mapSnapshot(
      {
        primary: { used_percent: 5, window_minutes: 300, resets_at: null, resets_in_seconds: 3_600 },
      },
      OBSERVED,
    );

    const fiveHour = windows['5h'];
    if (!isLive(fiveHour)) throw new Error('expected live');
    expect(fiveHour.resetsAt).toBe('2026-08-07T19:00:00.000Z');
  });

  it('does not invent a monthly percentage from a credit balance', () => {
    const windows = mapSnapshot(
      { primary: { used_percent: 5, window_minutes: 300 }, credits: { has_credits: true, balance: '$12.00' } },
      OBSERVED,
    );
    expect(windows.monthly.state).toBe('unavailable');
    expect(isLive(windows.monthly)).toBe(false);
  });

  it('treats unlimited credits as unsupported rather than as a full or empty bar', () => {
    const windows = mapSnapshot({ credits: { unlimited: true } }, OBSERVED);
    expect(windows.monthly.state).toBe('unsupported');
  });

  it('marks a window unavailable when the snapshot omits it', () => {
    const windows = mapSnapshot({ primary: { used_percent: 5, window_minutes: 300 } }, OBSERVED);
    expect(windows.weekly.state).toBe('unavailable');
  });
});

describe('scanLinesForSnapshot', () => {
  const line = (payload: unknown, timestamp = '2026-08-07T17:00:00.000Z'): string =>
    JSON.stringify({ timestamp, type: 'event_msg', payload });

  it('finds the newest snapshot, scanning from the end', () => {
    const text = [
      line({ type: 'token_count', rate_limits: { primary: { used_percent: 10, window_minutes: 300 } } }, '2026-08-07T16:00:00.000Z'),
      line({ type: 'token_count', rate_limits: { primary: { used_percent: 42, window_minutes: 300 } } }, '2026-08-07T17:00:00.000Z'),
    ].join('\n');

    const found = scanLinesForSnapshot(text, 0);
    expect(found?.snapshot.primary?.used_percent).toBe(42);
    expect(found?.observedAt).toBe('2026-08-07T17:00:00.000Z');
  });

  it('skips the documented null rate_limits case and keeps looking further back', () => {
    const text = [
      line({ type: 'token_count', rate_limits: { primary: { used_percent: 7, window_minutes: 300 } } }, '2026-08-07T15:00:00.000Z'),
      line({ type: 'token_count', rate_limits: null }, '2026-08-07T17:00:00.000Z'),
    ].join('\n');

    const found = scanLinesForSnapshot(text, 0);
    expect(found?.snapshot.primary?.used_percent).toBe(7);
  });

  it('returns nothing when every snapshot is null, rather than a zeroed reading', () => {
    const text = [line({ type: 'token_count', rate_limits: null })].join('\n');
    expect(scanLinesForSnapshot(text, 0)).toBeUndefined();
  });

  it('ignores a truncated first line, which a tail read always produces', () => {
    const good = line({ type: 'token_count', rate_limits: { primary: { used_percent: 3, window_minutes: 300 } } });
    const text = `{"timestamp":"2026-08-07T14:0\n${good}`;
    expect(scanLinesForSnapshot(text, 0)?.snapshot.primary?.used_percent).toBe(3);
  });

  it('accepts a flat record as well as a nested payload', () => {
    const text = JSON.stringify({
      timestamp: '2026-08-07T17:00:00.000Z',
      type: 'token_count',
      rate_limits: { primary: { used_percent: 9, window_minutes: 300 } },
    });
    expect(scanLinesForSnapshot(text, 0)?.snapshot.primary?.used_percent).toBe(9);
  });

  it('falls back to file mtime when the record carries no usable timestamp', () => {
    const mtime = Date.parse('2026-08-06T12:00:00.000Z');
    const text = JSON.stringify({
      type: 'event_msg',
      payload: { type: 'token_count', rate_limits: { primary: { used_percent: 1, window_minutes: 300 } } },
    });
    expect(scanLinesForSnapshot(text, mtime)?.observedAt).toBe('2026-08-06T12:00:00.000Z');
  });
});

describe('missing snapshots', () => {
  it('tells an unused Codex apart from one that logged no limits', async () => {
    // Signing in and never running Codex is not the upstream logging gap, and pointing a
    // new user at a bug report would send them chasing nothing.
    const { CodexAdapter } = await import('@main/providers/codex');
    const { AccountScope } = await import('@main/scope');
    const { mkdtemp, writeFile, mkdir } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');

    const logger = { info: () => {}, warn: () => {}, error: () => {} };
    const dir = await mkdtemp(join(tmpdir(), 'codex-'));
    await writeFile(
      join(dir, 'auth.json'),
      JSON.stringify({ tokens: { account_id: 'acct-123', id_token: null, access_token: 'tok' } }),
    );

    const adapter = new CodexAdapter();
    const unused = await adapter.probe(new AccountScope(dir), { now: new Date(), logger });
    const unusedWindow = unused.windows['5h'];
    expect(unusedWindow.state).toBe('unavailable');
    if (unusedWindow.state !== 'unavailable') throw new Error('expected unavailable');
    expect(unusedWindow.reason).toContain('no usage recorded yet');

    // Now with a session file that carries no rate limits at all.
    await mkdir(join(dir, 'sessions'), { recursive: true });
    await writeFile(
      join(dir, 'sessions', 'rollout-a.jsonl'),
      `${JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', rate_limits: null } })}\n`,
    );

    const used = await adapter.probe(new AccountScope(dir), { now: new Date(), logger });
    const usedWindow = used.windows['5h'];
    if (usedWindow.state !== 'unavailable') throw new Error('expected unavailable');
    expect(usedWindow.reason).toContain('reported no limits');
  });
});
