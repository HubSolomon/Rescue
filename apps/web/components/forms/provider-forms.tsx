"use client";

import { useActionState, useState } from "react";
import {
  addDocumentAction,
  addVehicleAction,
  completeJobAction,
  createProviderAction,
  respondToOfferAction,
  startJobAction,
  uploadEvidenceAction
} from "../../lib/actions/provider";
import type { FormState } from "../../lib/actions/jobs";
import { SubmitButton } from "./submit-button";
import { FormError, SuccessNote } from "../ui";
import type { Locale, Messages } from "../../i18n/index";

interface Base {
  locale: Locale;
  messages: Messages;
}

/**
 * Accept or decline an offer.
 *
 * Losing the race is a normal outcome, not an error state: another provider
 * accepted first. It gets its own sentence rather than a red failure box.
 */
export function OfferResponse({
  locale,
  messages,
  offerId,
  expired
}: Base & { offerId: string; expired: boolean }) {
  const [state, formAction] = useActionState<FormState, FormData>(respondToOfferAction, {});
  const [declining, setDeclining] = useState(false);

  if (state.ok) return <SuccessNote>{messages.provider.accepted}</SuccessNote>;
  if (state.errorCode === "OFFER_ALREADY_TAKEN") {
    return <p className="muted">{messages.provider.lost}</p>;
  }

  return (
    <form action={formAction} className="inline-form">
      <input type="hidden" name="locale" value={locale} />
      <input type="hidden" name="offerId" value={offerId} />

      {declining && (
        <label htmlFor={`decline-${offerId}`}>
          {messages.provider.declineReason}
          <input id={`decline-${offerId}`} name="reason" />
        </label>
      )}

      <FormError code={state.errorCode} messages={messages} />

      <div className="actions">
        {!declining && !expired && (
          <SubmitButton name="decision" value="ACCEPT" pendingLabel={messages.common.loading}>
            {messages.provider.accept}
          </SubmitButton>
        )}
        {declining ? (
          <SubmitButton name="decision" value="DECLINE" variant="secondary">
            {messages.provider.decline}
          </SubmitButton>
        ) : (
          <button type="button" className="button ghost" onClick={() => setDeclining(true)}>
            {messages.provider.decline}
          </button>
        )}
      </div>
    </form>
  );
}

export function StartJobForm({ locale, messages, jobId }: Base & { jobId: string }) {
  const [state, formAction] = useActionState<FormState, FormData>(startJobAction, {});
  if (state.ok) return <SuccessNote>{messages.provider.start}</SuccessNote>;
  return (
    <form action={formAction}>
      <input type="hidden" name="locale" value={locale} />
      <input type="hidden" name="jobId" value={jobId} />
      <FormError code={state.errorCode} messages={messages} />
      <SubmitButton pendingLabel={messages.common.loading}>{messages.provider.start}</SubmitButton>
    </form>
  );
}

export function CompleteJobForm({
  locale,
  messages,
  jobId,
  hasEvidence
}: Base & { jobId: string; hasEvidence: boolean }) {
  const [state, formAction] = useActionState<FormState, FormData>(completeJobAction, {});
  if (state.ok) return <SuccessNote>{messages.provider.complete}</SuccessNote>;

  return (
    <form action={formAction}>
      <input type="hidden" name="locale" value={locale} />
      <input type="hidden" name="jobId" value={jobId} />
      {!hasEvidence && <p className="muted">{messages.provider.completeBlocked}</p>}
      <FormError code={state.errorCode} messages={messages} />
      <button type="submit" className="button" disabled={!hasEvidence}>
        {messages.provider.complete}
      </button>
    </form>
  );
}

export function EvidenceUploadForm({ locale, messages, jobId }: Base & { jobId: string }) {
  const [state, formAction] = useActionState<FormState, FormData>(uploadEvidenceAction, {});

  return (
    <form action={formAction} className="form">
      <input type="hidden" name="locale" value={locale} />
      <input type="hidden" name="jobId" value={jobId} />

      <div className="form-grid">
        <label htmlFor="kind">
          {messages.provider.evidenceKind}
          <select id="kind" name="kind" defaultValue="DELIVERY_PHOTO">
            {(["PICKUP_PHOTO", "DELIVERY_PHOTO", "SIGNATURE", "DAMAGE_REPORT"] as const).map(
              (kind) => (
                <option key={kind} value={kind}>
                  {messages.provider.evidenceKinds[kind]}
                </option>
              )
            )}
          </select>
        </label>
        <label htmlFor="file">
          {messages.provider.evidenceFile}
          <input
            id="file"
            name="file"
            type="file"
            required
            accept="image/jpeg,image/png,image/webp,application/pdf"
          />
        </label>
      </div>

      {state.ok && <SuccessNote>{messages.provider.evidenceUploaded}</SuccessNote>}
      <FormError code={state.errorCode} messages={messages} />
      <SubmitButton pendingLabel={messages.common.loading}>
        {messages.provider.evidenceUpload}
      </SubmitButton>
    </form>
  );
}

export function ProviderOnboardingForm({ locale, messages }: Base) {
  const [state, formAction] = useActionState<FormState, FormData>(createProviderAction, {});

  return (
    <form action={formAction} className="form">
      <input type="hidden" name="locale" value={locale} />
      <div className="form-grid">
        <label htmlFor="legalName">
          {messages.provider.legalName}
          <input id="legalName" name="legalName" required minLength={2} />
        </label>
        <label htmlFor="contactEmail">
          {messages.provider.contactEmail}
          <input id="contactEmail" name="contactEmail" type="email" required />
        </label>
        <label htmlFor="basePostalCode">
          {messages.provider.basePostalCode}
          <input
            id="basePostalCode"
            name="basePostalCode"
            inputMode="numeric"
            pattern="\d{5}"
            required
          />
        </label>
        <label htmlFor="serviceRadiusKm">
          {messages.provider.serviceRadiusKm}
          <input
            id="serviceRadiusKm"
            name="serviceRadiusKm"
            type="number"
            min={1}
            max={200}
            defaultValue={30}
          />
        </label>
      </div>

      <fieldset>
        <legend>{messages.provider.serviceTypes}</legend>
        {(["FAILED_DELIVERY", "BULKY_RETURN", "COMPANY_SURPLUS"] as const).map((type) => (
          <label className="checkbox" key={type} htmlFor={`type-${type}`}>
            <input id={`type-${type}`} type="checkbox" name="serviceTypes" value={type} />
            <span>{messages.job.type[type]}</span>
          </label>
        ))}
      </fieldset>

      <FormError code={state.errorCode} messages={messages} />
      <SubmitButton pendingLabel={messages.common.loading}>
        {messages.provider.onboardingSubmit}
      </SubmitButton>
    </form>
  );
}

export function AddVehicleForm({ locale, messages, providerId }: Base & { providerId: string }) {
  const [state, formAction] = useActionState<FormState, FormData>(addVehicleAction, {});

  return (
    <form action={formAction} className="form">
      <input type="hidden" name="locale" value={locale} />
      <input type="hidden" name="providerId" value={providerId} />
      <div className="form-grid">
        <label htmlFor="registration">
          {messages.provider.registration}
          <input id="registration" name="registration" required aria-describedby="registration-hint" />
          <span className="muted small" id="registration-hint">
            {messages.provider.registrationHint}
          </span>
        </label>
        <label htmlFor="vehicleClass">
          {messages.dispatch.vehicleClass}
          <select id="vehicleClass" name="vehicleClass" defaultValue="LARGE_VAN">
            {(["CARGO_BIKE", "SMALL_VAN", "LARGE_VAN", "BOX_VAN", "TRUCK"] as const).map((v) => (
              <option key={v} value={v}>
                {messages.job.vehicle[v]}
              </option>
            ))}
          </select>
        </label>
        <label htmlFor="payloadKg">
          {messages.provider.payloadKg}
          <input id="payloadKg" name="payloadKg" type="number" min={1} required />
        </label>
        <label htmlFor="volumeM3">
          {messages.provider.volumeM3}
          <input id="volumeM3" name="volumeM3" inputMode="decimal" required />
        </label>
      </div>
      {state.ok && <SuccessNote>{messages.common.save}</SuccessNote>}
      <FormError code={state.errorCode} messages={messages} />
      <SubmitButton pendingLabel={messages.common.loading}>
        {messages.provider.addVehicle}
      </SubmitButton>
    </form>
  );
}

export function AddDocumentForm({ locale, messages, providerId }: Base & { providerId: string }) {
  const [state, formAction] = useActionState<FormState, FormData>(addDocumentAction, {});

  return (
    <form action={formAction} className="form">
      <input type="hidden" name="locale" value={locale} />
      <input type="hidden" name="providerId" value={providerId} />
      <div className="form-grid">
        <label htmlFor="type">
          {messages.provider.documentType}
          <select id="type" name="type" defaultValue="LIABILITY_INSURANCE">
            {(
              [
                "LIABILITY_INSURANCE",
                "CARGO_INSURANCE",
                "TRADE_LICENCE",
                "WASTE_CARRIER_PERMIT",
                "VEHICLE_REGISTRATION"
              ] as const
            ).map((type) => (
              <option key={type} value={type}>
                {messages.provider.documentTypes[type]}
              </option>
            ))}
          </select>
        </label>
        <label htmlFor="storageKey">
          Referenz
          <input id="storageKey" name="storageKey" required minLength={3} />
        </label>
        <label htmlFor="expiresAt">
          {messages.provider.documentExpiry} <span className="muted">({messages.common.optional})</span>
          <input id="expiresAt" name="expiresAt" type="date" />
        </label>
      </div>
      {state.ok && <SuccessNote>{messages.common.save}</SuccessNote>}
      <FormError code={state.errorCode} messages={messages} />
      <SubmitButton pendingLabel={messages.common.loading}>
        {messages.provider.addDocument}
      </SubmitButton>
    </form>
  );
}
