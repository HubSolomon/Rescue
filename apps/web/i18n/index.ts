import { de, type Messages } from "./messages.de";
import { en } from "./messages.en";

/** German first: Bremen is the pilot market, so `de` is the default locale. */
export const LOCALES = ["de", "en"] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = "de";

const CATALOGUES: Record<Locale, Messages> = { de, en };

export function isLocale(value: string | undefined): value is Locale {
  return value !== undefined && (LOCALES as readonly string[]).includes(value);
}

export function resolveLocale(value: string | undefined): Locale {
  return isLocale(value) ? value : DEFAULT_LOCALE;
}

export function getMessages(locale: Locale): Messages {
  return CATALOGUES[locale];
}

/** Substitutes `{name}` placeholders. Unknown placeholders are left intact. */
export function interpolate(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) =>
    key in values ? String(values[key]) : match
  );
}

/* ------------------------------------------------------------- formatting */

/**
 * Formats integer euro cents. The API speaks only in cents; this is the one
 * place a monetary value becomes a string, and the result never re-enters a
 * calculation.
 */
export function formatMoney(cents: number, locale: Locale): string {
  return new Intl.NumberFormat(locale === "de" ? "de-DE" : "en-IE", {
    style: "currency",
    currency: "EUR"
  }).format(cents / 100);
}

export function formatDate(iso: string, locale: Locale): string {
  return new Intl.DateTimeFormat(locale === "de" ? "de-DE" : "en-GB", {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(new Date(iso));
}

export function formatDateOnly(iso: string, locale: Locale): string {
  return new Intl.DateTimeFormat(locale === "de" ? "de-DE" : "en-GB", {
    dateStyle: "medium"
  }).format(new Date(iso));
}

/** "in 12 Minuten" / "in 12 minutes", or the past equivalent. */
export function formatRelative(iso: string, locale: Locale, now = new Date()): string {
  const deltaMs = new Date(iso).getTime() - now.getTime();
  const formatter = new Intl.RelativeTimeFormat(locale === "de" ? "de-DE" : "en-GB", {
    numeric: "auto"
  });
  const units: [Intl.RelativeTimeFormatUnit, number][] = [
    ["day", 86_400_000],
    ["hour", 3_600_000],
    ["minute", 60_000]
  ];
  for (const [unit, ms] of units) {
    if (Math.abs(deltaMs) >= ms || unit === "minute") {
      return formatter.format(Math.round(deltaMs / ms), unit);
    }
  }
  return formatter.format(0, "minute");
}

/** The other locale, for the language toggle. */
export function otherLocale(locale: Locale): Locale {
  return locale === "de" ? "en" : "de";
}

export type { Messages };
