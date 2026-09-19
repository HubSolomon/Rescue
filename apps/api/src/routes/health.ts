import type { FastifyPluginAsync } from "fastify";

export interface HealthDeps {
  /** Resolves when dependencies are reachable; rejects otherwise. */
  checkReadiness: () => Promise<{ store: "ok" | "unavailable" }>;
  version: string;
}

/**
 * Liveness and readiness are separate endpoints on purpose (finding L5).
 *
 * `/health` answers "is this process alive" and touches nothing, so an
 * orchestrator does not kill a healthy process because the database blinked.
 * `/ready` answers "should traffic be routed here" and does check dependencies.
 */
export const healthRoutes =
  (deps: HealthDeps): FastifyPluginAsync =>
  async (app) => {
    app.get("/health", async () => ({
      status: "ok",
      service: "rescue-api",
      version: deps.version,
      timestamp: new Date().toISOString()
    }));

    app.get("/ready", async (_request, reply) => {
      const checks = await deps.checkReadiness();
      const ready = Object.values(checks).every((value) => value === "ok");
      return reply.code(ready ? 200 : 503).send({
        status: ready ? "ready" : "not-ready",
        checks,
        timestamp: new Date().toISOString()
      });
    });
  };
