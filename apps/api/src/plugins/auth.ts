import type { FastifyInstance, FastifyRequest } from "fastify";
import fp from "fastify-plugin";
import {
  isProviderRole,
  isStaffRole,
  type Principal,
  type UserRole
} from "@rescue/contracts";
import { bearerToken, type TokenVerifier } from "../lib/auth/verifier.js";
import { forbidden, organizationRequired, providerContextRequired, unauthenticated } from "../lib/errors.js";
import { orgScope, staffScope, type Actor, type Scope } from "../store/types.js";
import type { Store } from "../store/types.js";

/**
 * Authentication and authorisation.
 *
 * Registered as a global `onRequest` hook, so routes are protected by default
 * and exemptions are an explicit allow-list. Finding C1 existed because the
 * opposite was true: nothing was protected and protection had to be
 * remembered per route.
 */

export interface AuthContext {
  principal: Principal;
  /** Roles held in the resolved tenant context, plus any staff roles. */
  roles: UserRole[];
  organizationId: string | null;
  providerId: string | null;
  isStaff: boolean;
  actor: Actor;
  /** Scope for store reads. Staff read across tenants; everyone else does not. */
  scope: Scope;
}

declare module "fastify" {
  interface FastifyRequest {
    auth?: AuthContext;
  }
}

/** Routes that may be reached without credentials. Everything else may not. */
const PUBLIC_PATHS = new Set(["/v1/health", "/v1/ready", "/v1/openapi.json", "/v1/auth/dev-token"]);

function resolveOrganization(principal: Principal, requested: string | undefined): string | null {
  const organizationIds = [
    ...new Set(
      principal.memberships
        .map((membership) => membership.organizationId)
        .filter((id): id is string => id !== null)
    )
  ];
  if (requested !== undefined) {
    // The header only *selects* among memberships the user already holds. It
    // can never introduce one, so it is not a tenant-spoofing vector.
    if (!organizationIds.includes(requested)) throw forbidden("You are not a member of that organisation");
    return requested;
  }
  if (organizationIds.length === 1) return organizationIds[0]!;
  if (organizationIds.length === 0) return null;
  throw organizationRequired();
}

function resolveProvider(principal: Principal, requested: string | undefined): string | null {
  const providerIds = [
    ...new Set(
      principal.memberships
        .map((membership) => membership.providerId)
        .filter((id): id is string => id !== null)
    )
  ];
  if (requested !== undefined) {
    if (!providerIds.includes(requested)) throw forbidden("You are not a member of that provider");
    return requested;
  }
  if (providerIds.length === 1) return providerIds[0]!;
  if (providerIds.length === 0) return null;
  throw providerContextRequired();
}

function headerValue(request: FastifyRequest, name: string): string | undefined {
  const raw = request.headers[name];
  if (Array.isArray(raw)) return raw[0];
  return typeof raw === "string" && raw.length > 0 ? raw : undefined;
}

export function buildAuthContext(
  principal: Principal,
  organizationId: string | null,
  providerId: string | null,
  correlationId: string
): AuthContext {
  const roles = principal.memberships
    .filter(
      (membership) =>
        isStaffRole(membership.role) ||
        (membership.organizationId !== null && membership.organizationId === organizationId) ||
        (membership.providerId !== null && membership.providerId === providerId)
    )
    .map((membership) => membership.role);

  const isStaff = roles.some(isStaffRole);
  return {
    principal,
    roles: [...new Set(roles)],
    organizationId,
    providerId,
    isStaff,
    actor: { userId: principal.userId, role: roles[0] ?? "CUSTOMER_MEMBER", correlationId },
    // Staff deliberately read across tenants. Everyone else is pinned to their
    // organisation, and a user with no organisation gets a scope that matches
    // nothing rather than a scope that matches everything.
    scope: isStaff ? staffScope() : orgScope(organizationId ?? "__none__")
  };
}

export interface AuthPluginOptions {
  verifier: TokenVerifier;
  store: Store;
}

export const authPlugin = fp<AuthPluginOptions>(async (app: FastifyInstance, options) => {
  app.addHook("onRequest", async (request) => {
    if (PUBLIC_PATHS.has(request.url.split("?")[0] ?? request.url)) return;

    const token = bearerToken(request.headers.authorization);
    const verified = await options.verifier.verify(token);

    const user = await options.store.findUserBySubject(verified.subject);
    // A token can be perfectly valid and still belong to nobody here. That is
    // 401, not 500, and it must not create a user implicitly.
    if (!user) throw unauthenticated("Token subject is not a known user");

    const principal: Principal = {
      userId: user.id,
      subject: user.subject,
      email: user.email,
      name: user.name,
      memberships: user.memberships
    };

    const organizationId = resolveOrganization(principal, headerValue(request, "x-organization-id"));
    const providerId = resolveProvider(principal, headerValue(request, "x-provider-id"));

    request.auth = buildAuthContext(principal, organizationId, providerId, request.id);
  });
});

/* -------------------------------------------------------------- accessors */

export function requireAuth(request: FastifyRequest): AuthContext {
  if (!request.auth) throw unauthenticated();
  return request.auth;
}

/** Throws unless the caller holds at least one of `roles`. */
export function requireRole(request: FastifyRequest, ...roles: UserRole[]): AuthContext {
  const auth = requireAuth(request);
  if (!auth.roles.some((role) => roles.includes(role))) {
    throw forbidden(`This action requires one of: ${roles.join(", ")}`);
  }
  return auth;
}

/** Throws unless the caller is acting inside a customer organisation. */
export function requireOrganization(request: FastifyRequest): AuthContext & { organizationId: string } {
  const auth = requireAuth(request);
  if (auth.organizationId === null) throw forbidden("This action requires an organisation membership");
  return auth as AuthContext & { organizationId: string };
}

/** Throws unless the caller is acting on behalf of a provider. */
export function requireProvider(request: FastifyRequest): AuthContext & { providerId: string } {
  const auth = requireAuth(request);
  if (auth.providerId === null || !auth.roles.some(isProviderRole)) {
    throw forbidden("This action requires a provider membership");
  }
  return auth as AuthContext & { providerId: string };
}
