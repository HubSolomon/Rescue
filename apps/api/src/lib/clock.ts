/**
 * Time as an injected dependency.
 *
 * Offer expiry, quote validity and idempotency TTLs are all time-dependent.
 * Tests that assert on expiry must be able to move the clock rather than sleep
 * for twenty minutes, and a test that sleeps is a test that gets deleted.
 */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = {
  now: () => new Date()
};

export class FixedClock implements Clock {
  constructor(private current: Date) {}
  now(): Date {
    return new Date(this.current);
  }
  advance(milliseconds: number): void {
    this.current = new Date(this.current.getTime() + milliseconds);
  }
  set(date: Date): void {
    this.current = new Date(date);
  }
}

export const MINUTE_MS = 60_000;
export const HOUR_MS = 60 * MINUTE_MS;
export const DAY_MS = 24 * HOUR_MS;
