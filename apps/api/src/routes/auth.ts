import type { FastifyPluginAsync } from "fastify";
import { devTokenRequestSchema, type WhoAmI } from "@rescue/contracts";
import { requireAuth } from "../plugins/auth.js";
import { AppError, notFound } from "../lib/errors.js";
import type { DevTokenIssuer } from "../lib/auth/verifier.js";
import type { Store } from "../store/types.js";

export interface AuthRouteDeps {
  store: Store;
  devIssuer: DevTokenIssuer | null;
}

export const authRoutes =
  (deps: AuthRouteDeps): FastifyPluginAsync =>
  async (app) => {
    /**
     * Development identity provider.
     *
     * Mints a token for a user that already exists. It cannot create users and
     * cannot grant a role, so the worst it can do in a development environment
     * is impersonate a seeded account. `devIssuer` is null whenever a real
     * OIDC provider is configured or NODE_ENV is production, and then this
     * route answers 404 as though it were not deployed at all.
     */
    app.post("/auth/dev-token", async (request, reply) => {
      if (!deps.devIssuer) throw notFound("Route");

      const input = devTokenRequestSchema.parse(request.body);
      const user = await deps.store.findUserBySubject(input.subject);
      if (!user) throw new AppError(400, "VALIDATION_ERROR", "No user with that subject");

      const { token, expiresAt } = await deps.devIssuer.issue(user.subject, input.expiresInSeconds, {
        email: user.email,
        name: user.name
      });

      request.log.warn(
        { subject: user.subject },
        "development token issued; this endpoint does not exist in production"
      );

      return reply.code(201).send({
        data: { accessToken: token, tokenType: "Bearer", expiresAt: expiresAt.toISOString() }
      });
    });

    /** Who the bearer token belongs to, and which tenant it is acting in. */
    app.get("/auth/me", async (request) => {
      const auth = requireAuth(request);
      const body: WhoAmI = {
        user: auth.principal,
        activeOrganizationId: auth.organizationId,
        activeProviderId: auth.providerId,
        roles: auth.roles
      };
      return { data: body };
    });
  };
