import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { DATA_INVENTORY } from "../lib/privacy.js";
import { requireRole } from "../plugins/auth.js";
import type { Clock } from "../lib/clock.js";
import type { Store } from "../store/types.js";

export interface PrivacyDeps {
  store: Store;
  clock: Clock;
}

const erasureRequest = z.object({
  userId: z.string().uuid(),
  /**
   * Required, free text, and stored in the audit log.
   *
   * Erasure is irreversible and the record of *why* is the only thing that
   * distinguishes it afterwards from an attack. Making the field optional
   * would mean the reason is absent in exactly the cases where it is most
   * needed.
   */
  reason: z.string().min(10).max(500)
});

/**
 * Data-protection operations.
 *
 * These exist as endpoints rather than as a runbook full of SQL because the
 * thirty-day deadline in Article 12(3) is not one a company meets by opening a
 * psql session, and because an erasure performed by hand leaves no audit trail
 * of who performed it.
 *
 * Compliance and admin only. A dispatcher can see a customer's address all day
 * and still has no business erasing a person.
 */
export const privacyRoutes =
  (deps: PrivacyDeps): FastifyPluginAsync =>
  async (app) => {
    /**
     * The inventory, served from the same constant the tests hold against the
     * schema. A record of processing activities that is generated cannot
     * describe a table that does not exist, which is the usual failure of one
     * kept in a document.
     */
    app.get("/privacy/inventory", async (request) => {
      requireRole(request, "COMPLIANCE", "ADMIN");
      return {
        data: {
          tables: DATA_INVENTORY,
          generatedAt: deps.clock.now().toISOString()
        }
      };
    });

    app.post("/privacy/erasure", async (request, reply) => {
      const auth = requireRole(request, "COMPLIANCE", "ADMIN");
      const body = erasureRequest.parse(request.body);

      const result = await deps.store.erasePerson({
        userId: body.userId,
        now: deps.clock.now(),
        actor: auth.actor
      });

      // 200 either way, and `erased` says which. A 404 for an
      // already-erased user would confirm that a user id once existed, and a
      // 409 would invite a retry loop against an operation that is complete.
      return reply.code(200).send({
        data: {
          userId: body.userId,
          erased: result.erased,
          evidenceUnlinked: result.evidenceUnlinked,
          /**
           * Said plainly, because the common misunderstanding is that erasure
           * empties the database. It does not: Article 17(3)(b) leaves the
           * commercial and tax records in place, and what has gone is the link
           * from those records to a named person.
           */
          note: result.erased
            ? "Name, email and identity-provider subject removed. Commercial and tax records retained under Article 17(3)(b); they no longer resolve to a person."
            : "No change: this user does not exist or was already erased."
        }
      });
    });
  };
