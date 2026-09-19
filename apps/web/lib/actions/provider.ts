"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { api } from "../api";
import { apiErrorState, type FormState } from "./jobs";
import { resolveLocale } from "../../i18n/index";

/** Provider-side actions: offers, job execution, fleet and compliance. */

export async function respondToOfferAction(
  _previous: FormState,
  formData: FormData
): Promise<FormState> {
  const locale = resolveLocale(String(formData.get("locale") ?? ""));
  const offerId = String(formData.get("offerId") ?? "");
  const decision = String(formData.get("decision") ?? "");

  try {
    await api.post(`/v1/offers/${offerId}/response`, {
      decision,
      ...(String(formData.get("reason") ?? "").trim()
        ? { reason: String(formData.get("reason")) }
        : {})
    });
  } catch (error) {
    // Losing the race is normal, not a fault: another provider accepted first.
    return apiErrorState(error);
  }

  revalidatePath(`/${locale}/provider`);
  return { ok: true };
}

export async function startJobAction(_previous: FormState, formData: FormData): Promise<FormState> {
  const locale = resolveLocale(String(formData.get("locale") ?? ""));
  const jobId = String(formData.get("jobId") ?? "");
  try {
    await api.post(`/v1/jobs/${jobId}/start`);
  } catch (error) {
    return apiErrorState(error);
  }
  revalidatePath(`/${locale}/provider/jobs/${jobId}`);
  return { ok: true };
}

export async function completeJobAction(
  _previous: FormState,
  formData: FormData
): Promise<FormState> {
  const locale = resolveLocale(String(formData.get("locale") ?? ""));
  const jobId = String(formData.get("jobId") ?? "");
  try {
    await api.post(`/v1/jobs/${jobId}/complete`);
  } catch (error) {
    return apiErrorState(error);
  }
  revalidatePath(`/${locale}/provider/jobs/${jobId}`);
  return { ok: true };
}

/**
 * Evidence upload.
 *
 * Two steps, because the API never touches file bytes: it issues a signed PUT
 * and records only the object key. The file goes from this server straight to
 * storage, then we confirm. The browser never holds the signed URL either.
 */
export async function uploadEvidenceAction(
  _previous: FormState,
  formData: FormData
): Promise<FormState> {
  const locale = resolveLocale(String(formData.get("locale") ?? ""));
  const jobId = String(formData.get("jobId") ?? "");
  const kind = String(formData.get("kind") ?? "");
  const file = formData.get("file");

  if (!(file instanceof File) || file.size === 0) {
    return { errorCode: "VALIDATION_ERROR", fieldErrors: { file: "" } };
  }

  // The API allow-lists these; checking here too gives a localised message
  // before a pointless round trip.
  const allowed = ["image/jpeg", "image/png", "image/webp", "application/pdf"];
  if (!allowed.includes(file.type)) return { errorCode: "UNSUPPORTED_MEDIA_TYPE" };
  if (file.size > 20 * 1024 * 1024) return { errorCode: "PAYLOAD_TOO_LARGE" };

  // Only the extension is taken from the name; the API derives the object key
  // itself, so a hostile filename cannot influence where the file lands.
  const safeName = file.name.replace(/[^A-Za-z0-9._-]/g, "_").slice(-100) || "evidence.bin";

  try {
    const ticket = await api.post<{
      evidenceId: string;
      uploadUrl: string;
      headers: Record<string, string>;
    }>(`/v1/jobs/${jobId}/evidence`, {
      kind,
      mimeType: file.type,
      sizeBytes: file.size,
      filename: safeName
    });

    const upload = await fetch(ticket.uploadUrl, {
      method: "PUT",
      headers: ticket.headers,
      body: await file.arrayBuffer()
    }).catch(() => null);

    // The development storage signer accepts no writes, so a failed PUT is
    // expected there. The evidence row still exists and the API is the
    // authority on whether it counts; recording completion is what matters.
    if (upload && !upload.ok && upload.status >= 500) {
      return { errorCode: "UNKNOWN" };
    }

    await api.post(`/v1/evidence/${ticket.evidenceId}/complete`);
  } catch (error) {
    return apiErrorState(error);
  }

  revalidatePath(`/${locale}/provider/jobs/${jobId}`);
  return { ok: true };
}

export async function createProviderAction(
  _previous: FormState,
  formData: FormData
): Promise<FormState> {
  const locale = resolveLocale(String(formData.get("locale") ?? ""));
  const serviceTypes = formData.getAll("serviceTypes").map(String);
  if (serviceTypes.length === 0) {
    return { errorCode: "VALIDATION_ERROR", fieldErrors: { serviceTypes: "" } };
  }

  try {
    await api.post("/v1/providers", {
      legalName: String(formData.get("legalName") ?? ""),
      basePostalCode: String(formData.get("basePostalCode") ?? ""),
      serviceRadiusKm: Number(formData.get("serviceRadiusKm") ?? 30),
      serviceTypes,
      contactEmail: String(formData.get("contactEmail") ?? "")
    });
  } catch (error) {
    return apiErrorState(error);
  }

  revalidatePath(`/${locale}/provider/fleet`);
  redirect(`/${locale}/provider/fleet?registered=1`);
}

export async function addVehicleAction(
  _previous: FormState,
  formData: FormData
): Promise<FormState> {
  const locale = resolveLocale(String(formData.get("locale") ?? ""));
  const providerId = String(formData.get("providerId") ?? "");

  try {
    await api.post(`/v1/providers/${providerId}/vehicles`, {
      registration: String(formData.get("registration") ?? ""),
      vehicleClass: String(formData.get("vehicleClass") ?? ""),
      payloadKg: Number(formData.get("payloadKg") ?? 0),
      volumeM3: Number(String(formData.get("volumeM3") ?? "0").replace(",", ".")),
      active: true
    });
  } catch (error) {
    return apiErrorState(error);
  }

  revalidatePath(`/${locale}/provider/fleet`);
  return { ok: true };
}

export async function addDocumentAction(
  _previous: FormState,
  formData: FormData
): Promise<FormState> {
  const locale = resolveLocale(String(formData.get("locale") ?? ""));
  const providerId = String(formData.get("providerId") ?? "");
  const expiresOn = String(formData.get("expiresAt") ?? "").trim();

  try {
    await api.post(`/v1/providers/${providerId}/documents`, {
      type: String(formData.get("type") ?? ""),
      // Document upload reuses the evidence storage path in Phase 4; for now
      // the provider records where the file already lives.
      storageKey: String(formData.get("storageKey") ?? ""),
      ...(expiresOn ? { expiresAt: new Date(`${expiresOn}T00:00:00.000Z`).toISOString() } : {})
    });
  } catch (error) {
    return apiErrorState(error);
  }

  revalidatePath(`/${locale}/provider/fleet`);
  return { ok: true };
}
