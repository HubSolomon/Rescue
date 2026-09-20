import "server-only";
import { cookies } from "next/headers";

/**
 * Server-side session.
 *
 * The access token lives in an httpOnly cookie and is read only in Server
 * Components, Server Actions and Route Handlers. It is never serialised into
 * a page payload, never held in React state, and never written to
 * localStorage or sessionStorage — the Phase 3 brief requires all three, and
 * a token in browser storage is readable by any injected script.
 */

export const SESSION_COOKIE = "rescue_session";
/** Slightly under the API's one-hour token lifetime, so the cookie dies first. */
export const SESSION_MAX_AGE_SECONDS = 55 * 60;

export interface SessionCookieOptions {
  httpOnly: true;
  sameSite: "lax";
  secure: boolean;
  path: "/";
  maxAge: number;
}

export function sessionCookieOptions(): SessionCookieOptions {
  return {
    httpOnly: true,
    // Lax rather than Strict so a link into the app from an email still lands
    // on an authenticated page; the API is bearer-token based, so this cookie
    // is not itself a CSRF vector for cross-site writes.
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: SESSION_MAX_AGE_SECONDS
  };
}

export async function readSessionToken(): Promise<string | null> {
  const store = await cookies();
  const value = store.get(SESSION_COOKIE)?.value;
  return value && value.length > 0 ? value : null;
}

export async function writeSessionToken(token: string): Promise<void> {
  const store = await cookies();
  store.set(SESSION_COOKIE, token, sessionCookieOptions());
}

export async function clearSessionToken(): Promise<void> {
  const store = await cookies();
  store.set(SESSION_COOKIE, "", { ...sessionCookieOptions(), maxAge: 0 });
}
