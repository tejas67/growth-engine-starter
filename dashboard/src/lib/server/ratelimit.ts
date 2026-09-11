/**
 * Login rate limiting.
 *
 * The DECISION is a pure function over rows already read from `login_attempt`, so it
 * can be tested with a pinned clock and no database. The route does the reading and
 * the writing; this file only judges.
 *
 * Rule: once an IP has accumulated `maxAttempts` FAILURES inside the rolling window,
 * further attempts from that IP are refused until the oldest of those failures ages
 * out. A success inside the window does not clear the count — otherwise one lucky
 * guess would reset the meter for a guesser.
 */

export interface AttemptRow {
  success: boolean;
  at: Date;
}

export interface RateLimitDecision {
  blocked: boolean;
  /** Failures counted inside the window. */
  failures: number;
  /** Failures still allowed before the block engages. Zero when blocked. */
  remaining: number;
  /** Whole seconds until the block lifts. Zero when not blocked. */
  retryAfterSeconds: number;
  message: string;
}

export function evaluateRateLimit(
  attempts: AttemptRow[],
  now: Date,
  maxAttempts: number,
  windowMinutes: number,
): RateLimitDecision {
  const windowMs = windowMinutes * 60 * 1000;
  const windowStart = now.getTime() - windowMs;

  const failures = attempts
    .filter((a) => !a.success && a.at.getTime() > windowStart)
    .sort((a, b) => a.at.getTime() - b.at.getTime());

  const count = failures.length;
  const blocked = count >= maxAttempts;

  if (!blocked) {
    return {
      blocked: false,
      failures: count,
      remaining: Math.max(0, maxAttempts - count),
      retryAfterSeconds: 0,
      message: 'ok',
    };
  }

  // The block lifts when the failure that put us at the limit leaves the window.
  const decisive = failures[count - maxAttempts]!;
  const liftsAt = decisive.at.getTime() + windowMs;
  const retryAfterSeconds = Math.max(1, Math.ceil((liftsAt - now.getTime()) / 1000));

  return {
    blocked: true,
    failures: count,
    remaining: 0,
    retryAfterSeconds,
    message:
      `Too many failed sign-ins from this address (${count} in the last ${windowMinutes} minutes). ` +
      `Try again in about ${Math.ceil(retryAfterSeconds / 60)} minute(s).`,
  };
}

/** First non-empty forwarded address, else the socket address, else 'unknown'. */
export function clientIp(forwardedFor: string | null, socketAddress: string | null): string {
  if (forwardedFor) {
    const first = forwardedFor.split(',')[0]?.trim();
    if (first) return first;
  }
  return socketAddress?.trim() || 'unknown';
}
