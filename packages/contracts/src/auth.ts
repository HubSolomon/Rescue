import { z } from "zod";
import { isoDateTime, uuid } from "./common.js";

export const userRoles = [
  "CUSTOMER_ADMIN",
  "CUSTOMER_MEMBER",
  "PROVIDER_ADMIN",
  "PROVIDER_DRIVER",
  "DISPATCHER",
  "COMPLIANCE",
  "ADMIN"
] as const;
export const userRoleSchema = z.enum(userRoles);
export type UserRole = z.infer<typeof userRoleSchema>;

/** Roles that act inside a customer organisation. */
export const CUSTOMER_ROLES = ["CUSTOMER_ADMIN", "CUSTOMER_MEMBER"] as const satisfies readonly UserRole[];
/** Roles that act on behalf of a logistics provider. */
export const PROVIDER_ROLES = ["PROVIDER_ADMIN", "PROVIDER_DRIVER"] as const satisfies readonly UserRole[];
/** Roles that operate RESCUE itself and may cross tenant boundaries. */
export const STAFF_ROLES = ["DISPATCHER", "COMPLIANCE", "ADMIN"] as const satisfies readonly UserRole[];

export function isCustomerRole(role: UserRole): boolean {
  return (CUSTOMER_ROLES as readonly UserRole[]).includes(role);
}
export function isProviderRole(role: UserRole): boolean {
  return (PROVIDER_ROLES as readonly UserRole[]).includes(role);
}
export function isStaffRole(role: UserRole): boolean {
  return (STAFF_ROLES as readonly UserRole[]).includes(role);
}

export const membershipSchema = z.object({
  id: uuid(),
  role: userRoleSchema,
  organizationId: uuid().nullable(),
  providerId: uuid().nullable()
});
export type Membership = z.infer<typeof membershipSchema>;

/**
 * The authenticated caller. Tenancy is derived entirely from `memberships`,
 * which come from the database keyed by the token subject. Nothing here is
 * ever read from a request body or query string.
 */
export const principalSchema = z.object({
  userId: uuid(),
  subject: z.string().min(1),
  email: z.string().email(),
  name: z.string().min(1),
  memberships: z.array(membershipSchema)
});
export type Principal = z.infer<typeof principalSchema>;

export const whoAmISchema = z.object({
  user: principalSchema,
  activeOrganizationId: uuid().nullable(),
  activeProviderId: uuid().nullable(),
  roles: z.array(userRoleSchema)
});
export type WhoAmI = z.infer<typeof whoAmISchema>;

/**
 * Development identity provider. Mints a token for an existing seeded user so
 * the API can be exercised without standing up a real OIDC provider. The route
 * that serves this is refused outright when NODE_ENV is production.
 */
export const devTokenRequestSchema = z.object({
  subject: z.string().min(1).max(200),
  expiresInSeconds: z.number().int().min(60).max(86_400).default(3600)
});
export type DevTokenRequest = z.infer<typeof devTokenRequestSchema>;

export const devTokenResponseSchema = z.object({
  accessToken: z.string(),
  tokenType: z.literal("Bearer"),
  expiresAt: isoDateTime()
});
export type DevTokenResponse = z.infer<typeof devTokenResponseSchema>;
