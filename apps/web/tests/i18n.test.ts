import { describe, expect, it } from "vitest";
import { de } from "../i18n/messages.de";
import { en } from "../i18n/messages.en";
import {
  DEFAULT_LOCALE,
  formatDate,
  formatMoney,
  formatRelative,
  interpolate,
  isLocale,
  otherLocale,
  resolveLocale
} from "../i18n/index";

/** Walks a nested message object and returns every leaf path. */
function paths(value: unknown, prefix = ""): string[] {
  if (typeof value !== "object" || value === null) return [prefix];
  return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) =>
    paths(child, prefix ? `${prefix}.${key}` : key)
  );
}

describe("the catalogues stay in step", () => {
  it("English covers every German key", () => {
    expect(paths(en).sort()).toEqual(paths(de).sort());
  });

  it("no string is left empty in either language", () => {
    for (const [name, catalogue] of [
      ["de", de],
      ["en", en]
    ] as const) {
      const walk = (value: unknown, path: string): void => {
        if (typeof value === "string") {
          expect(value.trim().length, `${name}.${path}`).toBeGreaterThan(0);
          return;
        }
        for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
          walk(child, path ? `${path}.${key}` : key);
        }
      };
      walk(catalogue, "");
    }
  });

  it("German is actually German, not copied English", () => {
    // A cheap canary: if someone pastes the English file over the German one,
    // these diverge-by-construction strings collapse.
    expect(de.common.signIn).not.toBe(en.common.signIn);
    expect(de.job.status.COMPLETED).not.toBe(en.job.status.COMPLETED);
    expect(de.dispatch.title).not.toBe(en.dispatch.title);
  });

  it("placeholders match between languages", () => {
    const placeholders = (text: string) => (text.match(/\{(\w+)\}/g) ?? []).sort();
    expect(placeholders(en.customer.created)).toEqual(placeholders(de.customer.created));
    expect(placeholders(en.customer.detailTitle)).toEqual(placeholders(de.customer.detailTitle));
  });

  it("covers every documented API error code", () => {
    for (const code of [
      "UNAUTHENTICATED",
      "FORBIDDEN",
      "NOT_FOUND",
      "CONFLICT",
      "INVALID_STATE_TRANSITION",
      "OFFER_EXPIRED",
      "OFFER_ALREADY_TAKEN",
      "NO_ELIGIBLE_PROVIDER",
      "VALIDATION_ERROR",
      "RATE_LIMITED"
    ]) {
      expect(de.errors, code).toHaveProperty(code);
      expect(en.errors, code).toHaveProperty(code);
    }
  });
});

describe("locale resolution", () => {
  it("defaults to German", () => {
    expect(DEFAULT_LOCALE).toBe("de");
    expect(resolveLocale(undefined)).toBe("de");
    expect(resolveLocale("fr")).toBe("de");
  });

  it("recognises the two supported locales", () => {
    expect(isLocale("de")).toBe(true);
    expect(isLocale("en")).toBe(true);
    expect(isLocale("fr")).toBe(false);
  });

  it("toggles to the other one", () => {
    expect(otherLocale("de")).toBe("en");
    expect(otherLocale("en")).toBe("de");
  });
});

describe("formatting", () => {
  it("renders euros from integer cents, per locale", () => {
    // Non-breaking spaces vary by ICU build, so compare on the digits.
    expect(formatMoney(29_750, "de").replace(/\s/g, "")).toContain("297,50");
    expect(formatMoney(29_750, "en").replace(/\s/g, "")).toContain("297.50");
  });

  it("never renders a fractional cent", () => {
    expect(formatMoney(1, "de")).toMatch(/0,01/);
    expect(formatMoney(0, "de")).toMatch(/0,00/);
  });

  it("formats dates in the locale's order", () => {
    const iso = "2026-09-19T08:30:00.000Z";
    expect(formatDate(iso, "de")).toMatch(/2026/);
    expect(formatDate(iso, "en")).toMatch(/2026/);
  });

  it("describes offer expiry relative to now", () => {
    const now = new Date("2026-09-19T08:00:00.000Z");
    const soon = new Date(now.getTime() + 15 * 60_000).toISOString();
    expect(formatRelative(soon, "de", now)).toMatch(/15/);
  });

  it("substitutes placeholders and leaves unknown ones alone", () => {
    expect(interpolate("Anfrage {reference} angelegt", { reference: "RSC-1" })).toBe(
      "Anfrage RSC-1 angelegt"
    );
    expect(interpolate("{a} {b}", { a: "x" })).toBe("x {b}");
  });
});
