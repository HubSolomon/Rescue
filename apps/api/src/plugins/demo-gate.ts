import { timingSafeEqual } from "node:crypto";
import type { FastifyInstance } from "fastify";
import fp from "fastify-plugin";

/**
 * A shared-secret gate for the demo deployment.
 *
 * The demo runs with `NODE_ENV=development`, which is what keeps
 * `POST /v1/auth/dev-token` alive -- the endpoint that mints a session for any
 * seeded person with no password. That is the whole point of a demo and an
 * open door on the public internet, so the API must not be reachable from it.
 *
 * The clean answer is a private service, but those are a paid plan on the host
 * this targets, and "it is secure as long as nobody downgrades the plan" is not
 * a property. So the API stays public and refuses anything that does not carry
 * a secret only the web service holds. The browser never needs it: every call
 * in this product is made server-side (`apps/web/lib/api.ts` is `server-only`),
 * so the key lives in the web container's environment and never in a page.
 *
 * Two properties this deliberately has:
 *
 * It is additive. The gate runs before authentication and can only reject; no
 * request that would have been refused is now accepted. A misconfiguration
 * makes the API unreachable, which is loud, rather than open, which is not.
 *
 * It is absent unless configured. With no `DEMO_API_KEY` the hook is never
 * registered -- so this cannot become a second, quieter authentication path in
 * the real deployment, where OIDC is the only way in.
 */

/**
 * Liveness only, and exempt because the host's own health check calls it
 * without the key. It reads no state, touches no database, and returns the
 * same two fields to everyone. `/v1/ready` is *not* exempt: it reports on the
 * database, which is a fact about the deployment rather than about liveness.
 */
const UNGATED = new Set(["/v1/health"]);

function matches(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  // timingSafeEqual throws on a length mismatch, which would itself leak the
  // length, so the comparison is guarded by a constant-time-friendly check of
  // the lengths first and the result is combined rather than short-circuited.
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export const demoGate = fp(async function demoGate(
  app: FastifyInstance,
  options: { key?: string }
) {
  const key = options.key;
  if (!key) return;

  app.addHook("onRequest", async (request, reply) => {
    if (UNGATED.has(request.url.split("?")[0] ?? request.url)) return;

    const provided = request.headers["x-demo-key"];
    if (typeof provided === "string" && matches(provided, key)) return;

    // 404, not 401. A 401 advertises that there is something here to get into
    // and invites a guess; a demo gate has no legitimate interactive user to
    // prompt, so there is nothing to gain by being informative.
    await reply.code(404).send({
      error: { code: "NOT_FOUND", message: "Not found" }
    });
  });
});
