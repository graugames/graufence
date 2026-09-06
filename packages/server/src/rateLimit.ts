/**
 * Per-connection message throttling.
 *
 * A playing client sends about 25 messages a second: 20 pose updates, the
 * occasional action, a ping. A hostile one can send as fast as the socket will
 * carry, and every message costs parsing and simulation work shared with the
 * other player in the room. The bucket keeps one connection from turning into
 * everyone's lag.
 *
 * Refill is computed from timestamps rather than a timer, so the limiter costs
 * nothing when idle and cannot drift.
 */

export class TokenBucket {
  private tokens: number;
  private lastRefill: number;
  private burst: number;

  /**
   * @param ratePerSecond sustained message rate allowed.
   * @param burst how many messages may arrive at once (defaults to 2 s worth).
   */
  constructor(
    private ratePerSecond: number,
    burst = ratePerSecond * 2,
    now = Date.now(),
  ) {
    this.tokens = burst;
    this.burst = burst;
    this.lastRefill = now;
  }

  /** @returns true when the message may be handled, false when throttled. */
  take(now: number, cost = 1): boolean {
    const elapsed = Math.max(0, now - this.lastRefill) / 1000;
    this.lastRefill = now;
    this.tokens = Math.min(this.burst, this.tokens + elapsed * this.ratePerSecond);
    if (this.tokens < cost) return false;
    this.tokens -= cost;
    return true;
  }

  /** Remaining allowance, for diagnostics. */
  get available(): number {
    return this.tokens;
  }
}

/**
 * Counts how badly a connection is misbehaving.
 *
 * One throttled message is normal (a burst of pose updates after a stall).
 * Hundreds in a row is a client that will not stop, and the only useful
 * response left is to close the socket.
 */
export class AbuseCounter {
  private strikes = 0;

  constructor(private limit = 200) {}

  /** @returns true when the connection has earned a disconnect. */
  strike(): boolean {
    this.strikes++;
    return this.strikes >= this.limit;
  }

  forgive(): void {
    if (this.strikes > 0) this.strikes--;
  }

  get count(): number {
    return this.strikes;
  }
}
