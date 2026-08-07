/**
 * Poll scheduling.
 *
 * The backoff exists to be a good citizen: these endpoints serve a live subscription, and
 * continuing to poll every minute through an outage is both useless and rude. The delay
 * calculation is kept pure so it can be tested without waiting on real timers.
 */

import { MIN_POLL_SECONDS } from '@shared/config';
import type { UsageSnapshot } from '@shared/ipc';
import { isLive } from '@shared/window';

const MAX_BACKOFF_MULTIPLIER = 8;

/** Delay before the next poll, backing off exponentially while every account is failing. */
export function nextDelayMs(pollSeconds: number, consecutiveFailures: number): number {
  const base = Math.max(MIN_POLL_SECONDS, pollSeconds) * 1000;
  if (consecutiveFailures <= 0) return base;
  const multiplier = Math.min(2 ** consecutiveFailures, MAX_BACKOFF_MULTIPLIER);
  return base * multiplier;
}

/**
 * A pass counts as failed only when nothing anywhere is live.
 *
 * A snapshot with no accounts is not a failure — there is simply nothing to poll — and an
 * account that is legitimately "not connected" is a settled state, not an outage.
 */
export function isFailedPass(snapshot: UsageSnapshot): boolean {
  if (snapshot.accounts.length === 0) return false;

  let sawRetryable = false;
  for (const account of snapshot.accounts) {
    for (const measurement of Object.values(account.windows)) {
      if (isLive(measurement)) return false;
      if (measurement.state === 'unavailable' || measurement.state === 'error') sawRetryable = true;
    }
  }
  return sawRetryable;
}
