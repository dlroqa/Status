/**
 * Session expiry.
 *
 * Subscription sessions are short-lived — a Claude access token is good for hours — so an
 * app that polls for days has to know when the one it is holding has gone stale, rather than
 * firing a request that is certain to fail and reporting the 401 as if it were news.
 */

/** How close to expiry a session is treated as already needing a refresh. */
export const EXPIRY_GRACE_MS = 5 * 60 * 1000;

export type SessionState = 'valid' | 'expiring' | 'expired' | 'unknown';

export interface SessionStatus {
  readonly state: SessionState;
  /** Milliseconds until expiry; negative once past. Undefined when the session says nothing. */
  readonly remainingMs?: number;
}

/**
 * Classifies a session from the expiry timestamp the CLI stored alongside it.
 *
 * A missing or unparseable timestamp is `unknown`, not `valid`: some providers do not record
 * one, and assuming freshness would be a guess dressed up as a fact. Callers treat `unknown`
 * by simply trying the request, which answers the question authoritatively.
 */
export function sessionStatus(expiresAtMs: number | undefined, now: Date): SessionStatus {
  if (expiresAtMs === undefined || !Number.isFinite(expiresAtMs)) {
    return { state: 'unknown' };
  }

  const remainingMs = expiresAtMs - now.getTime();
  if (remainingMs <= 0) return { state: 'expired', remainingMs };
  if (remainingMs <= EXPIRY_GRACE_MS) return { state: 'expiring', remainingMs };
  return { state: 'valid', remainingMs };
}

/** True when the official client should be asked to refresh before the session is used. */
export function needsRefresh(status: SessionStatus): boolean {
  return status.state === 'expired' || status.state === 'expiring';
}
