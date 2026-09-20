import type { Money } from "./common.js";

/**
 * Integer-only money helpers.
 *
 * Every amount in RESCUE is a whole number of euro cents. Nothing here uses
 * floating point, because `0.1 + 0.2 !== 0.3` and a cent lost per quote is a
 * reconciliation failure that surfaces months later in an invoice dispute.
 */

/**
 * VAT on `netCents` at `rateBasisPoints` (1900 = 19%), rounded half-up to the
 * nearest cent. Half-up matches German invoicing convention (kaufmännisches
 * Runden); banker's rounding would under-collect on .5 cases.
 */
export function vatCents(netCents: number, rateBasisPoints: number): number {
  assertWholeCents(netCents, "netCents");
  if (!Number.isInteger(rateBasisPoints) || rateBasisPoints < 0) {
    throw new RangeError("rateBasisPoints must be a non-negative integer");
  }
  const scaled = netCents * rateBasisPoints;
  // +5000 then integer-divide by 10000 is half-up without touching floats.
  return Math.floor((scaled + 5_000) / 10_000);
}

export function money(netCents: number, rateBasisPoints: number): Money {
  const vat = vatCents(netCents, rateBasisPoints);
  return {
    netCents,
    vatCents: vat,
    grossCents: netCents + vat,
    currency: "EUR"
  };
}

export function sumCents(amounts: readonly number[]): number {
  return amounts.reduce((total, amount) => {
    assertWholeCents(amount, "amount");
    return total + amount;
  }, 0);
}

/** Display only. Never feed the result back into a calculation. */
export function formatEuro(cents: number, locale = "de-DE"): string {
  assertWholeCents(cents, "cents");
  const sign = cents < 0 ? "-" : "";
  const absolute = Math.abs(cents);
  const euros = Math.floor(absolute / 100);
  const remainder = absolute % 100;
  const formattedEuros = new Intl.NumberFormat(locale).format(euros);
  return `${sign}${formattedEuros},${String(remainder).padStart(2, "0")} €`;
}

export function assertWholeCents(value: number, label: string): void {
  if (!Number.isInteger(value)) {
    throw new RangeError(`${label} must be an integer number of cents, received ${value}`);
  }
  if (!Number.isSafeInteger(value)) {
    throw new RangeError(`${label} exceeds the safe integer range`);
  }
}
