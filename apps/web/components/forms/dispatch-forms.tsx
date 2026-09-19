"use client";

import { useActionState } from "react";
import type { TriageSuggestion } from "@rescue/contracts";
import {
  approveTriageAction,
  createOffersAction,
  createQuoteAction,
  fallbackAction
} from "../../lib/actions/dispatch";
import type { FormState } from "../../lib/actions/jobs";
import { SubmitButton } from "./submit-button";
import { FormError, SuccessNote } from "../ui";
import type { Locale, Messages } from "../../i18n/index";

const VEHICLES = ["CARGO_BIKE", "SMALL_VAN", "LARGE_VAN", "BOX_VAN", "TRUCK"] as const;
const ROUTES = [
  "DELIVER",
  "RETURN",
  "STORE",
  "REPAIR",
  "REUSE",
  "DONATE",
  "RECYCLE",
  "DISPOSAL"
] as const;

interface Common {
  locale: Locale;
  messages: Messages;
  jobId: string;
}

/**
 * Triage approval.
 *
 * The AI suggestion pre-fills the controls and is labelled as a suggestion.
 * The dispatcher can change every field, and nothing moves until they submit —
 * which is the whole point of `requiresHumanApproval`.
 */
export function ApproveTriageForm({
  locale,
  messages,
  jobId,
  suggestion
}: Common & { suggestion?: TriageSuggestion }) {
  const [state, formAction] = useActionState<FormState, FormData>(approveTriageAction, {});
  if (state.ok) return <SuccessNote>{messages.dispatch.triageApproved}</SuccessNote>;

  const suggestedVehicle =
    suggestion && suggestion.vehicleClass !== "MANUAL_REVIEW" ? suggestion.vehicleClass : "LARGE_VAN";
  const suggestedRoute =
    suggestion && suggestion.circularRoute !== "MANUAL_REVIEW" ? suggestion.circularRoute : "DELIVER";

  return (
    <form action={formAction} className="form">
      <input type="hidden" name="locale" value={locale} />
      <input type="hidden" name="jobId" value={jobId} />

      <div className="form-grid">
        <label htmlFor="vehicleClass">
          {messages.dispatch.vehicleClass}
          <select id="vehicleClass" name="vehicleClass" defaultValue={suggestedVehicle}>
            {VEHICLES.map((vehicle) => (
              <option key={vehicle} value={vehicle}>
                {messages.job.vehicle[vehicle]}
              </option>
            ))}
          </select>
        </label>
        <label htmlFor="workers">
          {messages.dispatch.workers}
          <input
            id="workers"
            name="workers"
            type="number"
            min={1}
            max={6}
            defaultValue={suggestion?.workers ?? 2}
          />
        </label>
        <label htmlFor="circularRoute">
          {messages.dispatch.circularRoute}
          <select id="circularRoute" name="circularRoute" defaultValue={suggestedRoute}>
            {ROUTES.map((route) => (
              <option key={route} value={route}>
                {messages.job.route[route]}
              </option>
            ))}
          </select>
        </label>
      </div>

      <label htmlFor="dispatcherNotes">
        {messages.dispatch.dispatcherNotes}
        <textarea id="dispatcherNotes" name="dispatcherNotes" />
      </label>

      <FormError code={state.errorCode} messages={messages} />
      <SubmitButton pendingLabel={messages.common.loading}>
        {messages.dispatch.approveSubmit}
      </SubmitButton>
    </form>
  );
}

export function CreateQuoteForm({ locale, messages, jobId }: Common) {
  const [state, formAction] = useActionState<FormState, FormData>(createQuoteAction, {});
  if (state.ok) return <SuccessNote>{messages.dispatch.quoteSent}</SuccessNote>;

  return (
    <form action={formAction} className="form">
      <input type="hidden" name="locale" value={locale} />
      <input type="hidden" name="jobId" value={jobId} />
      <div className="form-grid">
        <label htmlFor="netEuros">
          {messages.dispatch.quoteNetLabel} (EUR)
          <input
            id="netEuros"
            name="netEuros"
            inputMode="decimal"
            required
            aria-invalid={state.fieldErrors?.netEuros !== undefined ? true : undefined}
          />
        </label>
        <label htmlFor="validForHours">
          {messages.dispatch.quoteValidHours}
          <input
            id="validForHours"
            name="validForHours"
            type="number"
            min={1}
            max={720}
            defaultValue={72}
          />
        </label>
      </div>
      <FormError code={state.errorCode} messages={messages} />
      <SubmitButton pendingLabel={messages.common.loading}>
        {messages.dispatch.quoteSubmit}
      </SubmitButton>
    </form>
  );
}

export function CreateOffersForm({ locale, messages, jobId }: Common) {
  const [state, formAction] = useActionState<FormState, FormData>(createOffersAction, {});
  if (state.ok) return <SuccessNote>{messages.dispatch.offersSent}</SuccessNote>;

  return (
    <form action={formAction} className="form">
      <input type="hidden" name="locale" value={locale} />
      <input type="hidden" name="jobId" value={jobId} />
      <div className="form-grid">
        <label htmlFor="payoutEuros">
          {messages.dispatch.offerPayout} (EUR)
          <input id="payoutEuros" name="payoutEuros" inputMode="decimal" required />
        </label>
        <label htmlFor="expiresInMinutes">
          {messages.dispatch.offerExpiry}
          <input
            id="expiresInMinutes"
            name="expiresInMinutes"
            type="number"
            min={1}
            max={1440}
            defaultValue={20}
          />
        </label>
      </div>
      <FormError code={state.errorCode} messages={messages} />
      <SubmitButton pendingLabel={messages.common.loading}>
        {messages.dispatch.offerSubmit}
      </SubmitButton>
    </form>
  );
}

export function FallbackForm({ locale, messages, jobId }: Common) {
  const [state, formAction] = useActionState<FormState, FormData>(fallbackAction, {});
  if (state.ok) return <SuccessNote>{messages.dispatch.fallbackDone}</SuccessNote>;

  return (
    <form action={formAction} className="form">
      <input type="hidden" name="locale" value={locale} />
      <input type="hidden" name="jobId" value={jobId} />
      <label htmlFor="fallback-reason">
        {messages.dispatch.fallbackReason}
        <textarea id="fallback-reason" name="reason" required minLength={3} />
      </label>
      <FormError code={state.errorCode} messages={messages} />
      <SubmitButton variant="secondary" pendingLabel={messages.common.loading}>
        {messages.dispatch.fallbackSubmit}
      </SubmitButton>
    </form>
  );
}
