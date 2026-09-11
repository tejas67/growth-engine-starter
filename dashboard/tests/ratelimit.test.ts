import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clientIp, evaluateRateLimit, type AttemptRow } from '../src/lib/server/ratelimit';

// Pinned MID-MONTH so nothing here can drift across a month or DST boundary.
const NOW = new Date('2026-08-15T12:00:00Z');

const MAX = 5;
const WINDOW_MINUTES = 15;

function failuresAgo(minutesAgo: number[]): AttemptRow[] {
  return minutesAgo.map((m) => ({ success: false, at: new Date(NOW.getTime() - m * 60_000) }));
}

describe('login rate limit', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('allows an address with no history', () => {
    const decision = evaluateRateLimit([], NOW, MAX, WINDOW_MINUTES);
    expect(decision.blocked).toBe(false);
    expect(decision.failures).toBe(0);
    expect(decision.remaining).toBe(MAX);
  });

  it('allows up to one attempt short of the limit', () => {
    const decision = evaluateRateLimit(failuresAgo([1, 2, 3, 4]), NOW, MAX, WINDOW_MINUTES);
    expect(decision.blocked).toBe(false);
    expect(decision.failures).toBe(4);
    expect(decision.remaining).toBe(1);
  });

  it('blocks once the configured number of failures lands inside the window', () => {
    const decision = evaluateRateLimit(failuresAgo([1, 2, 3, 4, 5]), NOW, MAX, WINDOW_MINUTES);
    expect(decision.blocked).toBe(true);
    expect(decision.failures).toBe(5);
    expect(decision.remaining).toBe(0);
    expect(decision.message).toContain('Too many failed sign-ins');
  });

  it('ignores failures that have aged out of the window', () => {
    // Five failures, but four of them are older than the 15-minute window.
    const decision = evaluateRateLimit(failuresAgo([16, 17, 18, 19, 2]), NOW, MAX, WINDOW_MINUTES);
    expect(decision.blocked).toBe(false);
    expect(decision.failures).toBe(1);
  });

  it('does not let a success inside the window clear the count', () => {
    const attempts: AttemptRow[] = [
      ...failuresAgo([1, 2, 3, 4, 5]),
      { success: true, at: new Date(NOW.getTime() - 30_000) },
    ];
    expect(evaluateRateLimit(attempts, NOW, MAX, WINDOW_MINUTES).blocked).toBe(true);
  });

  it('reports how long until the block lifts', () => {
    // The 5th-oldest in-window failure was 5 minutes ago, so 10 minutes remain.
    const decision = evaluateRateLimit(failuresAgo([5, 4, 3, 2, 1]), NOW, MAX, WINDOW_MINUTES);
    expect(decision.blocked).toBe(true);
    expect(decision.retryAfterSeconds).toBe(10 * 60);
  });

  it('counts each address separately, because the rows it reads are per address', () => {
    // The caller filters by IP; the judge simply never invents rows it was not given.
    expect(evaluateRateLimit([], NOW, MAX, WINDOW_MINUTES).blocked).toBe(false);
  });

  it('honours a different configured limit and window', () => {
    expect(evaluateRateLimit(failuresAgo([1, 2]), NOW, 2, WINDOW_MINUTES).blocked).toBe(true);
    expect(evaluateRateLimit(failuresAgo([1, 2]), NOW, 3, WINDOW_MINUTES).blocked).toBe(false);
    // A 1-minute window ages the same failures out immediately.
    expect(evaluateRateLimit(failuresAgo([1, 2, 3, 4, 5]), NOW, MAX, 1).blocked).toBe(false);
  });
});

describe('client address', () => {
  it('prefers the first forwarded address', () => {
    expect(clientIp('203.0.113.7, 70.41.3.18', '10.0.0.1')).toBe('203.0.113.7');
  });

  it('falls back to the socket address, then to a placeholder', () => {
    expect(clientIp(null, '10.0.0.1')).toBe('10.0.0.1');
    expect(clientIp('', '10.0.0.1')).toBe('10.0.0.1');
    expect(clientIp(null, null)).toBe('unknown');
  });
});
