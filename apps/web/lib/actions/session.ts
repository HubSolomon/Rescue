"use server";

import { redirect } from "next/navigation";
import { exchangeDevToken } from "../api";
import { clearSessionToken, writeSessionToken } from "../session";
import { currentUser, homePathFor } from "../auth";
import { resolveLocale } from "../../i18n/index";

export interface ActionState {
  errorCode?: string;
  ok?: boolean;
}

/**
 * Development sign-in.
 *
 * Exchanges a seeded subject for a token on the server and stores it in an
 * httpOnly cookie. The token is never returned to the browser. Replaced by an
 * OIDC redirect flow once an identity provider is configured; the rest of the
 * app reads the session through the same cookie either way, so nothing else
 * changes when that happens.
 */
export async function signInAction(
  _previous: ActionState,
  formData: FormData
): Promise<ActionState> {
  const subject = String(formData.get("subject") ?? "");
  const locale = resolveLocale(String(formData.get("locale") ?? ""));
  if (!subject) return { errorCode: "VALIDATION_ERROR" };

  try {
    const token = await exchangeDevToken(subject);
    await writeSessionToken(token);
  } catch (error) {
    const code = (error as { code?: string }).code;
    return { errorCode: code ?? "UNKNOWN" };
  }

  const user = await currentUser();
  redirect(user ? homePathFor(user, locale) : `/${locale}`);
}

export async function signOutAction(formData: FormData): Promise<void> {
  const locale = resolveLocale(String(formData.get("locale") ?? ""));
  await clearSessionToken();
  redirect(`/${locale}`);
}
