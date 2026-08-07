import { describe, expect, it } from 'vitest';
import type { AccountUsage } from '@shared/account';
import { selectMenuBarDisplay } from '@shared/menubar';
import { allWindows, errored, live, notConnected, unavailable } from '@shared/window';

const OBSERVED = '2026-08-07T18:00:00.000Z';

function reading(percent: number) {
  return live({ percent, source: 'test', observedAt: OBSERVED });
}

function account(id: string, label: string, windows: AccountUsage['windows']): AccountUsage {
  return {
    accountId: id as AccountUsage['accountId'],
    provider: 'claude',
    label,
    windows,
    fetchedAt: OBSERVED,
  };
}

describe('selectMenuBarDisplay', () => {
  it('reports nothing when no accounts are connected', () => {
    const display = selectMenuBarDisplay([], { source: 'closest' });
    expect(display.title).toBe('—');
    expect(display.severity).toBeUndefined();
  });

  describe('closest to its limit', () => {
    it('picks the highest reading across every account and window', () => {
      const accounts = [
        account('claude:a', 'Personal', { '5h': reading(20), weekly: reading(35), monthly: reading(5) }),
        account('claude:b', 'Work', { '5h': reading(12), weekly: reading(88), monthly: reading(9) }),
      ];

      const display = selectMenuBarDisplay(accounts, { source: 'closest' });
      expect(display.title).toBe('88%');
      expect(display.severity).toBe('critical');
      expect(display.accountId).toBe('claude:b');
      expect(display.windowKind).toBe('weekly');
      expect(display.detail).toContain('Work');
    });

    it('ignores accounts with no reading rather than treating them as zero', () => {
      // An unreadable account must never win by looking like 0%, nor drag the figure down.
      const accounts = [
        account('claude:a', 'Down', allWindows(unavailable('rate limited'))),
        account('claude:b', 'Live', { '5h': reading(41), weekly: reading(10), monthly: reading(1) }),
      ];

      const display = selectMenuBarDisplay(accounts, { source: 'closest' });
      expect(display.title).toBe('41%');
      expect(display.accountId).toBe('claude:b');
    });

    it('shows no figure when every account is unreadable', () => {
      const accounts = [account('claude:a', 'Only', allWindows(errored('session expired')))];
      const display = selectMenuBarDisplay(accounts, { source: 'closest' });

      expect(display.title).toBe('—');
      expect(display.severity).toBeUndefined();
      expect(display.detail).toContain('Only');
    });

    it('crosses the amber and red thresholds at exactly 50 and 85', () => {
      const at = (percent: number) =>
        selectMenuBarDisplay([account('claude:a', 'A', allWindows(reading(percent)))], { source: 'closest' })
          .severity;

      expect(at(49.9)).toBe('normal');
      expect(at(50)).toBe('elevated');
      expect(at(84.9)).toBe('elevated');
      expect(at(85)).toBe('critical');
    });
  });

  describe('a chosen account', () => {
    const accounts = [
      account('claude:a', 'Personal', { '5h': reading(20), weekly: reading(90), monthly: reading(5) }),
      account('claude:b', 'Work', { '5h': reading(63), weekly: reading(10), monthly: reading(9) }),
    ];

    it('shows that account, and its 5-hour window specifically', () => {
      const display = selectMenuBarDisplay(accounts, { source: 'chosen', accountId: 'claude:b' });
      expect(display.title).toBe('63%');
      expect(display.accountId).toBe('claude:b');
      expect(display.windowKind).toBe('5h');
    });

    it('does not silently follow the highest account when one is pinned', () => {
      // Personal's weekly is 90%, but the user pinned Work; showing 90% would be wrong.
      const display = selectMenuBarDisplay(accounts, { source: 'chosen', accountId: 'claude:b' });
      expect(display.title).not.toBe('90%');
    });

    it('falls back to the first account when the pinned one has been removed', () => {
      const display = selectMenuBarDisplay(accounts, { source: 'chosen', accountId: 'claude:gone' });
      expect(display.accountId).toBe('claude:a');
    });

    it('shows the reason, not a percentage, when the chosen account has no reading', () => {
      const offline = [account('claude:a', 'Personal', allWindows(notConnected('not signed in')))];
      const display = selectMenuBarDisplay(offline, { source: 'chosen', accountId: 'claude:a' });

      expect(display.title).toBe('—');
      expect(display.severity).toBeUndefined();
      expect(display.detail).toContain('not signed in');
    });
  });
});
