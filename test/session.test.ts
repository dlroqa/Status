import { describe, expect, it } from 'vitest';
import { EXPIRY_GRACE_MS, needsRefresh, sessionStatus } from '@shared/session';

const NOW = new Date('2026-08-07T18:00:00.000Z');
const at = (offsetMs: number): number => NOW.getTime() + offsetMs;

describe('sessionStatus', () => {
  it('is valid while there is comfortable time left', () => {
    const status = sessionStatus(at(60 * 60 * 1000), NOW);
    expect(status.state).toBe('valid');
    expect(status.remainingMs).toBe(60 * 60 * 1000);
  });

  it('is expiring inside the grace window, so a refresh happens before the request fails', () => {
    expect(sessionStatus(at(EXPIRY_GRACE_MS - 1_000), NOW).state).toBe('expiring');
    expect(sessionStatus(at(EXPIRY_GRACE_MS), NOW).state).toBe('expiring');
  });

  it('is valid just outside the grace window', () => {
    expect(sessionStatus(at(EXPIRY_GRACE_MS + 1_000), NOW).state).toBe('valid');
  });

  it('is expired once the moment has passed', () => {
    expect(sessionStatus(at(0), NOW).state).toBe('expired');
    expect(sessionStatus(at(-1_000), NOW).state).toBe('expired');
  });

  it('reports unknown rather than assuming freshness when no expiry was recorded', () => {
    // Some providers record no expiry. Calling that "valid" would be a guess presented as
    // fact; unknown lets the caller simply try, which answers it authoritatively.
    expect(sessionStatus(undefined, NOW).state).toBe('unknown');
    expect(sessionStatus(Number.NaN, NOW).state).toBe('unknown');
  });
});

describe('needsRefresh', () => {
  it('refreshes when expired or about to expire', () => {
    expect(needsRefresh({ state: 'expired' })).toBe(true);
    expect(needsRefresh({ state: 'expiring' })).toBe(true);
  });

  it('does not refresh a healthy session, nor one whose state is unknown', () => {
    expect(needsRefresh({ state: 'valid' })).toBe(false);
    // Refreshing on unknown would run the CLI on every single poll.
    expect(needsRefresh({ state: 'unknown' })).toBe(false);
  });
});
