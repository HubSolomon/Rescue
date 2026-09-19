"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createJobSchema } from "@rescue/contracts";
import { api, ApiError } from "../api";
import { resolveLocale } from "../../i18n/index";

export interface FormState {
  errorCode?: string;
  /** Field path -> message, for inline validation. */
  fieldErrors?: Record<string, string>;
  ok?: boolean;
  reference?: string;
}

function apiErrorState(error: unknown): FormState {
  if (error instanceof ApiError) {
    const fieldErrors: Record<string, string> = {};
    if (Array.isArray(error.details)) {
      for (const issue of error.details as { path?: string; message?: string }[]) {
        if (issue.path) fieldErrors[issue.path] = issue.message ?? "";
      }
    }
    return { errorCode: error.code, fieldErrors };
  }
  return { errorCode: "UNKNOWN" };
}

function optional(value: FormDataEntryValue | null): string | undefined {
  const text = typeof value === "string" ? value.trim() : "";
  return text.length > 0 ? text : undefined;
}

/**
 * Create a recovery request.
 *
 * Note what is absent: any organisation field. The API derives the tenant from
 * the session, and the contract has no place to put one — see finding C2.
 */
export async function createJobAction(_previous: FormState, formData: FormData): Promise<FormState> {
  const locale = resolveLocale(String(formData.get("locale") ?? ""));

  const candidate = {
    type: String(formData.get("type") ?? ""),
    urgency: String(formData.get("urgency") ?? ""),
    pickup: {
      line1: String(formData.get("pickupLine1") ?? ""),
      postalCode: String(formData.get("pickupPostalCode") ?? ""),
      city: String(formData.get("pickupCity") ?? ""),
      countryCode: "DE" as const
    },
    destination: optional(formData.get("destinationLine1"))
      ? {
          line1: String(formData.get("destinationLine1")),
          postalCode: String(formData.get("destinationPostalCode") ?? ""),
          city: String(formData.get("destinationCity") ?? ""),
          countryCode: "DE" as const
        }
      : undefined,
    items: [
      {
        name: String(formData.get("itemName") ?? ""),
        quantity: Number(formData.get("itemQuantity") ?? 1),
        ...(optional(formData.get("itemWeight"))
          ? { estimatedWeightKg: Number(formData.get("itemWeight")) }
          : {})
      }
    ],
    stairs: Number(formData.get("stairs") ?? 0),
    liftAvailable: formData.get("liftAvailable") === "on",
    customerReference: optional(formData.get("customerReference")),
    notes: optional(formData.get("notes"))
  };

  // Validated client-side too, but the server is the one that counts.
  const parsed = createJobSchema.safeParse(candidate);
  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      fieldErrors[issue.path.join(".")] = issue.message;
    }
    return { errorCode: "VALIDATION_ERROR", fieldErrors };
  }

  let jobId: string;
  try {
    const result = await api.post<{ job: { id: string } }>("/v1/jobs", parsed.data);
    jobId = result.job.id;
  } catch (error) {
    return apiErrorState(error);
  }

  revalidatePath(`/${locale}/customer`);
  redirect(`/${locale}/customer/${jobId}?created=1`);
}

export async function decideQuoteAction(_previous: FormState, formData: FormData): Promise<FormState> {
  const locale = resolveLocale(String(formData.get("locale") ?? ""));
  const quoteId = String(formData.get("quoteId") ?? "");
  const jobId = String(formData.get("jobId") ?? "");
  const decision = String(formData.get("decision") ?? "");

  try {
    await api.post(`/v1/quotes/${quoteId}/decision`, {
      decision,
      ...(optional(formData.get("reason")) ? { reason: String(formData.get("reason")) } : {})
    });
  } catch (error) {
    return apiErrorState(error);
  }

  revalidatePath(`/${locale}/customer/${jobId}`);
  return { ok: true };
}

export async function cancelJobAction(_previous: FormState, formData: FormData): Promise<FormState> {
  const locale = resolveLocale(String(formData.get("locale") ?? ""));
  const jobId = String(formData.get("jobId") ?? "");
  const reason = String(formData.get("reason") ?? "");
  if (reason.trim().length < 3) {
    return { errorCode: "VALIDATION_ERROR", fieldErrors: { reason: "" } };
  }

  try {
    await api.post(`/v1/jobs/${jobId}/cancel`, { reason });
  } catch (error) {
    return apiErrorState(error);
  }

  revalidatePath(`/${locale}/customer/${jobId}`);
  return { ok: true };
}

export { apiErrorState };
