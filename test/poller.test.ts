import { describe, expect, it } from 'vitest';
import { isFailedPass, nextDelayMs } from '@main/poller';
import type { UsageSnapshot } from '@shared/ipc';
import { allWindows, errored, live, notConnected, unavailable } from '@shared/window';

function snapshotWith(windows: UsageSnapshot['accounts'][number]['windows']): UsageSnapshot {
  return {
    accounts: [
      { accountId: 'claude:a', provider: 'claude', label: 'A', windows, fetchedAt: '2026-08-07T18:00:00.000Z' },
    ],
    fetchedAt: '2026-08-07T18:00:00.000Z',
    refreshing: false,
  };
}

describe('nextDelayMs', () => {
  it('uses the configured interval when everything is healthy', () => {
    expect(nextDelayMs(60, 0)).toBe(60_000);
  });

  it('backs off while every account keeps failing, so an outage is not hammered', () => {
    expect(nextDelayMs(60, 1)).toBe(120_000);
    expect(nextDelayMs(60, 2)).toBe(240_000);
  });

  it('caps the backoff so the app still recovers promptly', () => {
    expect(nextDelayMs(60, 10)).toBe(60_000 * 8);
  });

  it('never polls faster than the floor, even if the config is coaxed lower', () => {
    expect(nextDelayMs(1, 0)).toBe(30_000);
  });
});

describe('isFailedPass', () => {
  const liveWindow = live({ percent: 5, source: 'test', observedAt: '2026-08-07T18:00:00.000Z' });

  it('is not a failure when anything is live', () => {
    expect(isFailedPass(snapshotWith({ ...allWindows(errored('x')), '5h': liveWindow }))).toBe(false);
  });

  it('is a failure when every window is retryable', () => {
    expect(isFailedPass(snapshotWith(allWindows(unavailable('network down'))))).toBe(true);
  });

  it('does not treat a settled "not connected" state as an outage to back off from', () => {
    expect(isFailedPass(snapshotWith(allWindows(notConnected('not signed in'))))).toBe(false);
  });

  it('does not treat having no accounts as a failure', () => {
    expect(
      isFailedPass({ accounts: [], fetchedAt: '2026-08-07T18:00:00.000Z', refreshing: false }),
    ).toBe(false);
  });
});
