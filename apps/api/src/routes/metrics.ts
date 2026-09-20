import { timingSafeEqual } from "node:crypto";
import type { FastifyPluginAsync } from "fastify";
import type { MetricsRegistry } from "../lib/metrics.js";

export interface MetricsDeps {
  registry: MetricsRegistry;
  /** When set, a scrape must present it as a bearer token. */
  token: string | null;
}

/**
 * Constant-time compare on equal-length buffers.
 *
 * `timingSafeEqual` throws on a length mismatch, and the length of a token is
 * not a secret worth a branch, so an unequal length is simply not equal.
 */
function tokenMatches(presented: string, expected: string): boolean {
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * The scrape endpoint.
 *
 * Metrics are not public. The series here name route templates, queue depths
 * and job counts -- nothing personal, but plenty that helps someone map the
 * system, and `rescue_http_requests_total` by status is a free oracle for
 * whether an attack is landing. So: with a token configured, a scrape must
 * present it; with no token configured, the endpoint exists only outside
 * production, and `buildApp` refuses to register it otherwise. Fail closed,
 * rather than shipping an open endpoint that nobody notices until it is
 * indexed.
 *
 * The 401 carries no `WWW-Authenticate` challenge on purpose: a scraper is not
 * a browser and there is nothing useful for a human to be prompted for.
 */
export const metricsRoutes =
  (deps: MetricsDeps): FastifyPluginAsync =>
  async (app) => {
    app.get("/metrics", { config: { rateLimit: false } }, async (request, reply) => {
      if (deps.token !== null) {
        const header = request.headers.authorization;
        const presented = typeof header === "string" && header.startsWith("Bearer ")
          ? header.slice("Bearer ".length)
          : "";
        if (!tokenMatches(presented, deps.token)) {
          request.log.warn({ ip: request.ip }, "metrics scrape rejected");
          return reply.code(401).send({ error: { code: "UNAUTHORIZED", message: "Metrics require a token" } });
        }
      }
      const body = await deps.registry.scrape();
      return reply
        .code(200)
        .header("content-type", "text/plain; version=0.0.4; charset=utf-8")
        .header("cache-control", "no-store")
        .send(body);
    });
  };
