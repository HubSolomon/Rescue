import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";

/** Stable SHA-256 hex digest. */
export function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

/**
 * Canonical JSON so that two semantically identical request bodies hash to the
 * same value regardless of key order. Used for idempotency replay detection:
 * `{"a":1,"b":2}` and `{"b":2,"a":1}` are the same request.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, entry]) => [key, sortValue(entry)])
    );
  }
  return value;
}

export function requestHash(method: string, path: string, body: unknown): string {
  return sha256Hex(`${method.toUpperCase()} ${path} ${canonicalJson(body ?? null)}`);
}

/**
 * Keyed hash of a vehicle registration plate. A plate is personal data under
 * GDPR once it is linked to a provider, and RESCUE only ever needs to answer
 * "is this the same vehicle?" -- never "what is the plate?". Keyed rather than
 * plain SHA-256 because the plate space is small enough to brute force.
 */
export function registrationHash(registration: string, key: string): string {
  const normalised = registration.replace(/[\s-]/g, "").toUpperCase();
  return createHmac("sha256", key).update(normalised, "utf8").digest("hex");
}

export function constantTimeEquals(a: string, b: string): boolean {
  const bufferA = Buffer.from(a, "utf8");
  const bufferB = Buffer.from(b, "utf8");
  if (bufferA.length !== bufferB.length) return false;
  return timingSafeEqual(bufferA, bufferB);
}

export const newId = (): string => randomUUID();
