import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import {
  createProviderDocumentSchema,
  createProviderSchema,
  createVehicleSchema,
  providerStatusSchema,
  reviewDocumentSchema,
  reviewProviderSchema
} from "@rescue/contracts";
import { forbidden, notFound } from "../lib/errors.js";
import { registrationHash } from "../lib/crypto.js";
import { requireAuth, requireProvider, requireRole } from "../plugins/auth.js";
import type { Store, StoredProvider, StoredVehicle } from "../store/types.js";

export interface ProviderRouteDeps {
  store: Store;
  registrationHashKey: string;
}

const providerIdParams = z.object({ id: z.string().uuid() });
const documentIdParams = z.object({ id: z.string().uuid(), documentId: z.string().uuid() });

/** Never expose the registration hash; it is an internal de-duplication key. */
function publicVehicle(vehicle: StoredVehicle) {
  const { registrationHash: _hash, ...rest } = vehicle;
  return { ...rest, createdAt: vehicle.createdAt.toISOString() };
}

function publicProvider(provider: StoredProvider) {
  return {
    ...provider,
    createdAt: provider.createdAt.toISOString(),
    updatedAt: provider.updatedAt.toISOString()
  };
}

export const providerRoutes =
  (deps: ProviderRouteDeps): FastifyPluginAsync =>
  async (app) => {
    /**
     * A provider may read and write only its own record. Staff may read any.
     * Resolved here rather than in each handler so the rule is stated once.
     */
    const assertProviderAccess = (request: Parameters<typeof requireAuth>[0], providerId: string) => {
      const auth = requireAuth(request);
      if (auth.isStaff) return auth;
      if (auth.providerId !== providerId) throw notFound("Provider");
      return auth;
    };

    /** Onboarding. The provider starts PENDING and is not dispatchable. */
    app.post("/providers", async (request, reply) => {
      const auth = requireRole(request, "PROVIDER_ADMIN", "DISPATCHER", "ADMIN");
      const input = createProviderSchema.parse(request.body);
      const provider = await deps.store.createProvider({
        input,
        actor: auth.actor,
        ownerUserId: auth.principal.userId
      });
      return reply.code(201).send({ data: publicProvider(provider) });
    });

    app.get("/providers", async (request) => {
      requireRole(request, "DISPATCHER", "COMPLIANCE", "ADMIN");
      const query = z.object({ status: providerStatusSchema.optional() }).parse(request.query);
      const providers = await deps.store.listProviders({ status: query.status });
      return { data: providers.map(publicProvider) };
    });

    app.get("/providers/:id", async (request) => {
      const { id } = providerIdParams.parse(request.params);
      assertProviderAccess(request, id);
      const provider = await deps.store.findProvider(id);
      if (!provider) throw notFound("Provider");
      return { data: publicProvider(provider) };
    });

    /**
     * Activation is a compliance decision, never a self-service one. A
     * provider cannot move itself to ACTIVE, which is what makes the
     * eligibility gate meaningful.
     */
    app.post("/providers/:id/review", async (request) => {
      const auth = requireRole(request, "COMPLIANCE", "ADMIN");
      const { id } = providerIdParams.parse(request.params);
      const input = reviewProviderSchema.parse(request.body);
      const provider = await deps.store.setProviderStatus({
        providerId: id,
        status: input.status,
        reason: input.reason,
        actor: auth.actor
      });
      return { data: publicProvider(provider) };
    });

    /* -------------------------------------------------------------- fleet */

    app.post("/providers/:id/vehicles", async (request, reply) => {
      const { id } = providerIdParams.parse(request.params);
      const auth = requireAuth(request);
      if (!auth.isStaff) {
        const provider = requireProvider(request);
        if (provider.providerId !== id) throw forbidden("You may only manage your own fleet");
      }
      const input = createVehicleSchema.parse(request.body);

      const vehicle = await deps.store.createVehicle({
        providerId: id,
        input,
        // The plate is hashed here and the plaintext is never persisted.
        registrationHash: registrationHash(input.registration, deps.registrationHashKey),
        actor: auth.actor
      });
      return reply.code(201).send({ data: publicVehicle(vehicle) });
    });

    app.get("/providers/:id/vehicles", async (request) => {
      const { id } = providerIdParams.parse(request.params);
      assertProviderAccess(request, id);
      const vehicles = await deps.store.listVehicles(id);
      return { data: vehicles.map(publicVehicle) };
    });

    /* ---------------------------------------------------------- documents */

    app.post("/providers/:id/documents", async (request, reply) => {
      const { id } = providerIdParams.parse(request.params);
      const auth = requireAuth(request);
      if (!auth.isStaff) {
        const provider = requireProvider(request);
        if (provider.providerId !== id) throw forbidden("You may only manage your own documents");
      }
      const input = createProviderDocumentSchema.parse(request.body);
      const document = await deps.store.createDocument({ providerId: id, input, actor: auth.actor });
      return reply.code(201).send({
        data: {
          ...document,
          expiresAt: document.expiresAt?.toISOString() ?? null,
          reviewedAt: document.reviewedAt?.toISOString() ?? null,
          createdAt: document.createdAt.toISOString()
        }
      });
    });

    app.get("/providers/:id/documents", async (request) => {
      const { id } = providerIdParams.parse(request.params);
      assertProviderAccess(request, id);
      const documents = await deps.store.listDocuments(id);
      return {
        data: documents.map((document) => ({
          ...document,
          expiresAt: document.expiresAt?.toISOString() ?? null,
          reviewedAt: document.reviewedAt?.toISOString() ?? null,
          createdAt: document.createdAt.toISOString()
        }))
      };
    });

    /** Verification is a compliance action; a provider cannot verify itself. */
    app.post("/providers/:id/documents/:documentId/review", async (request) => {
      const auth = requireRole(request, "COMPLIANCE", "ADMIN");
      const { documentId } = documentIdParams.parse(request.params);
      const input = reviewDocumentSchema.parse(request.body);
      const document = await deps.store.reviewDocument({
        documentId,
        status: input.status,
        reason: input.reason,
        actor: auth.actor
      });
      return {
        data: {
          ...document,
          expiresAt: document.expiresAt?.toISOString() ?? null,
          reviewedAt: document.reviewedAt?.toISOString() ?? null,
          createdAt: document.createdAt.toISOString()
        }
      };
    });
  };
