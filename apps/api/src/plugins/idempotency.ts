import type { FastifyReply, FastifyRequest } from "fastify";
import { requestHash } from "../lib/crypto.js";
import { idempotencyKeyRequired, idempotencyKeyReused } from "../lib/errors.js";
import type { Store } from "../store/types.js";
import { HOUR_MS } from "../lib/clock.js";

/**
 * Idempotency for mutating requests (finding H4).
 *
 * A retry on a flaky mobile connection must not create a second job, and once
 * dispatch and payment are wired it must not authorise a second charge. The
 * caller supplies `Idempotency-Key`; the server stores the response against
 * (organisation, key) and replays it verbatim.
 *
 * A replay whose body differs from the original is refused with 409 rather
 * than served the old response: that combination means a client bug, and
 * silently returning the wrong resource would be worse than an error.
 */

export const IDEMPOTENCY_HEADER = "idempotency-key";

export interface IdempotencyOutcome {
  replayed: boolean;
  statusCode: number;
  body: unknown;
}

export interface IdempotencyRunner {
  /** Runs `work` at most once per (organisation, key). */
  run<T>(params: {
    request: FastifyRequest;
    reply: FastifyReply;
    organizationId: string;
    body: unknown;
    work: () => Promise<{ statusCode: number; body: T }>;
  }): Promise<T>;
}

export function createIdempotencyRunner(store: Store, ttlHours: number): IdempotencyRunner {
  return {
    async run({ request, reply, organizationId, body, work }) {
      const key = request.headers[IDEMPOTENCY_HEADER];
      const value = Array.isArray(key) ? key[0] : key;
      if (typeof value !== "string" || value.trim().length === 0) {
        throw idempotencyKeyRequired();
      }
      const trimmed = value.trim().slice(0, 200);
      const hash = requestHash(request.method, request.routeOptions.url ?? request.url, body);

      const existing = await store.findIdempotencyRecord(organizationId, trimmed);
      if (existing) {
        if (existing.requestHash !== hash) throw idempotencyKeyReused();
        reply.header("idempotent-replay", "true");
        reply.code(existing.statusCode);
        return existing.responseBody as never;
      }

      const result = await work();

      await store.saveIdempotencyRecord({
        key: trimmed,
        organizationId,
        method: request.method,
        path: request.routeOptions.url ?? request.url,
        requestHash: hash,
        statusCode: result.statusCode,
        responseBody: result.body,
        expiresAt: new Date(Date.now() + ttlHours * HOUR_MS)
      });

      reply.code(result.statusCode);
      return result.body;
    }
  };
}
