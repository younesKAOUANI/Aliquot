import { Injectable } from '@nestjs/common';

/**
 * A fixed-window request counter for the demo sign-in, held in this process's
 * memory.
 *
 * ## What this is honestly worth
 *
 * The counter lives in one process's heap. It is therefore **per instance**: two
 * API replicas behind a load balancer would allow twice the configured rate, and
 * a restart forgets every window. That is correct for the deployment this exists
 * for -- one container, one process -- and it is the first thing that has to
 * change if there is ever a second. The replacement is a row per window in
 * PostgreSQL (`insert ... on conflict do update ... returning count`, which is
 * one round trip and is atomic across replicas) or a shared store; the seam is
 * this class, and nothing outside it knows how the count is kept.
 *
 * It is also not a defence against a distributed attacker, who has as many
 * source addresses as they care to buy. What it defends against is the ordinary
 * failure: a script, a crawler, or a page with a retry loop hammering the one
 * endpoint on this service that does unauthenticated work.
 *
 * ## Why fixed window rather than a token bucket
 *
 * A fixed window admits up to twice the rate across a window boundary. For a
 * limit whose job is to keep a demo endpoint from being hammered, that is a
 * rounding error, and the alternative costs a per-key timestamp list or a
 * refill calculation for no property this needs. Being able to state exactly
 * what the limiter does in two sentences is worth more here than the precision.
 */

/** Windows are one minute because the configured limit is expressed per minute. */
const WINDOW_MS = 60_000;

/**
 * Above this many tracked keys, expired entries are swept before a new one is
 * admitted.
 *
 * Without a sweep the map grows once per distinct source address for the life of
 * the process, which is a memory leak an attacker chooses the size of. The sweep
 * is O(tracked) and runs only when the map is already large, so the ordinary
 * path stays a map lookup.
 */
const SWEEP_THRESHOLD = 10_000;

interface Window {
  startedAt: number;
  count: number;
}

export type RateLimitDecision =
  { allowed: true; remaining: number } | { allowed: false; retryAfterSeconds: number };

@Injectable()
export class DemoRateLimiter {
  private readonly windows = new Map<string, Window>();

  /**
   * Count one attempt against `key` and say whether it may proceed.
   *
   * `now` is a parameter so the window arithmetic is testable without waiting a
   * minute, and it defaults to the wall clock for every real caller.
   */
  consume(key: string, limit: number, now: number = Date.now()): RateLimitDecision {
    const existing = this.windows.get(key);

    if (existing === undefined || now - existing.startedAt >= WINDOW_MS) {
      if (this.windows.size >= SWEEP_THRESHOLD) {
        this.sweep(now);
      }
      this.windows.set(key, { startedAt: now, count: 1 });
      return { allowed: true, remaining: limit - 1 };
    }

    if (existing.count >= limit) {
      const remainingMs = existing.startedAt + WINDOW_MS - now;
      // At least one second: a `Retry-After: 0` invites the immediate retry the
      // header exists to prevent.
      return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil(remainingMs / 1000)) };
    }

    existing.count += 1;
    return { allowed: true, remaining: limit - existing.count };
  }

  private sweep(now: number): void {
    for (const [key, window] of this.windows) {
      if (now - window.startedAt >= WINDOW_MS) {
        this.windows.delete(key);
      }
    }
  }
}
