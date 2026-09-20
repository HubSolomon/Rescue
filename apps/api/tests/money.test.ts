import { describe, expect, it } from "vitest";
import { formatEuro, money, sumCents, vatCents, VAT_RATE_BASIS_POINTS } from "@rescue/contracts";

describe("VAT is integer arithmetic, rounded half-up", () => {
  it("computes the standard German rate", () => {
    expect(vatCents(10_000, VAT_RATE_BASIS_POINTS)).toBe(1_900);
    expect(vatCents(25_000, 1900)).toBe(4_750);
  });

  it("rounds a half cent up, as German invoicing requires", () => {
    // 50 cents at 19% is 9.5 cents exactly.
    expect(vatCents(50, 1900)).toBe(10);
    // 150 at 19% is 28.5.
    expect(vatCents(150, 1900)).toBe(29);
  });

  it("rounds below a half cent down", () => {
    expect(vatCents(10, 1900)).toBe(2); // 1.9 -> 2
    expect(vatCents(1, 1900)).toBe(0); // 0.19 -> 0
  });

  it("handles a zero rate and a zero amount", () => {
    expect(vatCents(10_000, 0)).toBe(0);
    expect(vatCents(0, 1900)).toBe(0);
  });

  it("never produces a fractional cent, across a wide sweep", () => {
    for (let net = 0; net < 5_000; net += 7) {
      const vat = vatCents(net, 1900);
      expect(Number.isInteger(vat)).toBe(true);
      expect(net + vat).toBe(money(net, 1900).grossCents);
    }
  });

  it("gross always equals net plus VAT, matching the database CHECK", () => {
    for (const net of [1, 99, 100, 12_345, 999_999]) {
      const result = money(net, 1900);
      expect(result.grossCents).toBe(result.netCents + result.vatCents);
      expect(result.currency).toBe("EUR");
    }
  });

  it("refuses a non-integer amount rather than silently truncating", () => {
    expect(() => vatCents(10.5, 1900)).toThrow(/integer number of cents/);
    expect(() => sumCents([1, 2.5])).toThrow(/integer number of cents/);
  });

  it("refuses a negative or fractional rate", () => {
    expect(() => vatCents(100, -1)).toThrow(/non-negative integer/);
    expect(() => vatCents(100, 19.5)).toThrow(/non-negative integer/);
  });
});

describe("float arithmetic would have been wrong", () => {
  it("avoids the classic 0.1 + 0.2 error", () => {
    // The float version of "ten cents plus twenty cents".
    expect(0.1 + 0.2).not.toBe(0.3);
    // The integer version is exact.
    expect(sumCents([10, 20])).toBe(30);
  });

  it("sums a long list without drift", () => {
    const amounts = Array.from({ length: 1000 }, () => 1);
    expect(sumCents(amounts)).toBe(1000);
  });
});

describe("formatting", () => {
  it("renders German euro formatting", () => {
    expect(formatEuro(0)).toBe("0,00 €");
    expect(formatEuro(5)).toBe("0,05 €");
    expect(formatEuro(1234)).toBe("12,34 €");
    expect(formatEuro(-1234)).toBe("-12,34 €");
  });

  it("pads the cents", () => {
    expect(formatEuro(100)).toBe("1,00 €");
    expect(formatEuro(101)).toBe("1,01 €");
  });
});
