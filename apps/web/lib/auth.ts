import "server-only";
import { redirect } from "next/navigation";
import type { UserRole, WhoAmI } from "@rescue/contracts";
import { api, ApiError } from "./api";
import type { Locale } from "../i18n/index";

/**
 * Role checks run on the server, before a page renders.
 *
 * The API enforces authorisation regardless — these guards exist so a user
 * never sees a console they cannot use, not as the security boundary. Hiding
 * a button is presentation; refusing the request is the control.
 */

export async function currentUser(): Promise<WhoAmI | null> {
  try {
    return await api.get<WhoAmI>("/v1/auth/me");
  } catch (error) {
    if (error instanceof ApiError && (error.status === 401 || error.code === "UNAUTHENTICATED")) {
      return null;
    }
    throw error;
  }
}

export async function requireUser(locale: Locale): Promise<WhoAmI> {
  const user = await currentUser();
  if (!user) redirect(`/${locale}/sign-in`);
  return user;
}

export async function requireRole(locale: Locale, ...roles: UserRole[]): Promise<WhoAmI> {
  const user = await requireUser(locale);
  if (!user.roles.some((role) => roles.includes(role))) {
    redirect(`/${locale}/no-access`);
  }
  return user;
}

export function hasRole(user: WhoAmI, ...roles: UserRole[]): boolean {
  return user.roles.some((role) => roles.includes(role));
}

export const CUSTOMER_ROLES: UserRole[] = ["CUSTOMER_ADMIN", "CUSTOMER_MEMBER"];
export const PROVIDER_ROLES: UserRole[] = ["PROVIDER_ADMIN", "PROVIDER_DRIVER"];
export const DISPATCH_ROLES: UserRole[] = ["DISPATCHER", "ADMIN"];
export const COMPLIANCE_ROLES: UserRole[] = ["COMPLIANCE", "ADMIN"];

/** Where a user lands after signing in, based on what they can actually do. */
export function homePathFor(user: WhoAmI, locale: Locale): string {
  if (hasRole(user, ...DISPATCH_ROLES)) return `/${locale}/dispatch`;
  if (hasRole(user, ...PROVIDER_ROLES)) return `/${locale}/provider`;
  if (hasRole(user, ...CUSTOMER_ROLES)) return `/${locale}/customer`;
  if (hasRole(user, "COMPLIANCE")) return `/${locale}/dispatch`;
  return `/${locale}`;
}
