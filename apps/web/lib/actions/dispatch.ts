"use server";

import { revalidatePath } from "next/cache";
import { api } from "../api";
import { apiErrorState, type FormState } from "./jobs";
import { resolveLocale } from "../../i18n/index";

/**
 * Dispatcher actions. Each one is the human decision the AI suggestion is not
 * permitted to make on its own.
 */

export async function approveTriageAction(
  _previous: FormState,
  formData: FormData
): Promise<FormState> {
  const locale = resolveLocale(String(formData.get("locale") ?? ""));
  const jobId = String(formData.get("jobId") ?? "");

  try {
    await api.post(`/v1/jobs/${jobId}/triage`, {
      vehicleClass: String(formData.get("vehicleClass") ?? ""),
      workers: Number(formData.get("workers") ?? 1),
      circularRoute: String(formData.get("circularRoute") ?? ""),
      ...(String(formData.get("dispatcherNotes") ?? "").trim()
        ? { dispatcherNotes: String(formData.get("dispatcherNotes")) }
        : {})
    });
  } catch (error) {
    return apiErrorState(error);
  }

  revalidatePath(`/${locale}/dispatch`);
  revalidatePath(`/${locale}/dispatch/${jobId}`);
  return { ok: true };
}

export async function createQuoteAction(
  _previous: FormState,
  formData: FormData
): Promise<FormState> {
  const locale = resolveLocale(String(formData.get("locale") ?? ""));
  const jobId = String(formData.get("jobId") ?? "");

  // The form collects euros; the API speaks only integer cents. Rounding here
  // rather than multiplying a float keeps the value exact.
  const euros = String(formData.get("netEuros") ?? "").replace(",", ".");
  const netCents = Math.round(Number(euros) * 100);
  if (!Number.isFinite(netCents) || netCents <= 0) {
    return { errorCode: "VALIDATION_ERROR", fieldErrors: { netEuros: "" } };
  }

  try {
    await api.post(`/v1/jobs/${jobId}/quotes`, {
      netCents,
      validForHours: Number(formData.get("validForHours") ?? 72)
    });
  } catch (error) {
    return apiErrorState(error);
  }

  revalidatePath(`/${locale}/dispatch/${jobId}`);
  return { ok: true };
}

export async function createOffersAction(
  _previous: FormState,
  formData: FormData
): Promise<FormState> {
  const locale = resolveLocale(String(formData.get("locale") ?? ""));
  const jobId = String(formData.get("jobId") ?? "");

  const euros = String(formData.get("payoutEuros") ?? "").replace(",", ".");
  const payoutNetCents = Math.round(Number(euros) * 100);
  if (!Number.isFinite(payoutNetCents) || payoutNetCents <= 0) {
    return { errorCode: "VALIDATION_ERROR", fieldErrors: { payoutEuros: "" } };
  }

  try {
    await api.post(`/v1/jobs/${jobId}/offers`, {
      payoutNetCents,
      expiresInMinutes: Number(formData.get("expiresInMinutes") ?? 20)
    });
  } catch (error) {
    return apiErrorState(error);
  }

  revalidatePath(`/${locale}/dispatch/${jobId}`);
  return { ok: true };
}

export async function fallbackAction(_previous: FormState, formData: FormData): Promise<FormState> {
  const locale = resolveLocale(String(formData.get("locale") ?? ""));
  const jobId = String(formData.get("jobId") ?? "");
  const reason = String(formData.get("reason") ?? "");
  if (reason.trim().length < 3) {
    return { errorCode: "VALIDATION_ERROR", fieldErrors: { reason: "" } };
  }

  try {
    await api.post(`/v1/jobs/${jobId}/fallback`, { reason });
  } catch (error) {
    return apiErrorState(error);
  }

  revalidatePath(`/${locale}/dispatch/${jobId}`);
  return { ok: true };
}
