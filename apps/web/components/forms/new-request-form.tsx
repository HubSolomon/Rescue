"use client";

import { useActionState } from "react";
import { createJobAction, type FormState } from "../../lib/actions/jobs";
import { SubmitButton } from "./submit-button";
import { FormError } from "../ui";
import type { Locale, Messages } from "../../i18n/index";

/**
 * There is no organisation field, visible or hidden. The API takes the tenant
 * from the session; the form has nothing to send and nothing to tamper with.
 */
export function NewRequestForm({ locale, messages }: { locale: Locale; messages: Messages }) {
  const [state, formAction] = useActionState<FormState, FormData>(createJobAction, {});
  const fieldError = (path: string) => state.fieldErrors?.[path];

  return (
    <form action={formAction} className="form" noValidate>
      <input type="hidden" name="locale" value={locale} />

      <div className="form-grid">
        <label htmlFor="type">
          {messages.customer.newTitle}
          <select id="type" name="type" defaultValue="FAILED_DELIVERY">
            <option value="FAILED_DELIVERY">{messages.job.type.FAILED_DELIVERY}</option>
            <option value="BULKY_RETURN">{messages.job.type.BULKY_RETURN}</option>
            <option value="COMPANY_SURPLUS">{messages.job.type.COMPANY_SURPLUS}</option>
          </select>
        </label>
        <label htmlFor="urgency">
          {messages.job.urgency.SCHEDULED} / {messages.job.urgency.URGENT}
          <select id="urgency" name="urgency" defaultValue="SCHEDULED">
            <option value="SCHEDULED">{messages.job.urgency.SCHEDULED}</option>
            <option value="SAME_DAY">{messages.job.urgency.SAME_DAY}</option>
            <option value="URGENT">{messages.job.urgency.URGENT}</option>
          </select>
        </label>
      </div>

      <h3>{messages.job.pickup}</h3>
      <div className="form-grid">
        <label htmlFor="pickupLine1">
          Straße und Hausnummer
          <input
            id="pickupLine1"
            name="pickupLine1"
            required
            aria-describedby={fieldError("pickup.line1") ? "pickupLine1-error" : undefined}
            aria-invalid={fieldError("pickup.line1") ? true : undefined}
          />
          {fieldError("pickup.line1") && (
            <span className="error" id="pickupLine1-error">
              {fieldError("pickup.line1")}
            </span>
          )}
        </label>
        <label htmlFor="pickupPostalCode">
          PLZ
          <input
            id="pickupPostalCode"
            name="pickupPostalCode"
            inputMode="numeric"
            pattern="\d{5}"
            required
            aria-describedby={
              fieldError("pickup.postalCode") ? "pickupPostalCode-error" : undefined
            }
            aria-invalid={fieldError("pickup.postalCode") ? true : undefined}
          />
          {fieldError("pickup.postalCode") && (
            <span className="error" id="pickupPostalCode-error">
              {fieldError("pickup.postalCode")}
            </span>
          )}
        </label>
        <label htmlFor="pickupCity">
          Stadt
          <input id="pickupCity" name="pickupCity" required />
        </label>
        <label htmlFor="customerReference">
          {messages.job.reference} <span className="muted">({messages.common.optional})</span>
          <input id="customerReference" name="customerReference" />
        </label>
      </div>

      <h3>
        {messages.job.destination} <span className="muted">({messages.common.optional})</span>
      </h3>
      <div className="form-grid">
        <label htmlFor="destinationLine1">
          Straße und Hausnummer
          <input id="destinationLine1" name="destinationLine1" />
        </label>
        <label htmlFor="destinationPostalCode">
          PLZ
          <input id="destinationPostalCode" name="destinationPostalCode" inputMode="numeric" />
        </label>
        <label htmlFor="destinationCity">
          Stadt
          <input id="destinationCity" name="destinationCity" />
        </label>
      </div>

      <h3>{messages.job.items}</h3>
      <div className="form-grid">
        <label htmlFor="itemName">
          Bezeichnung
          <input
            id="itemName"
            name="itemName"
            required
            aria-invalid={fieldError("items.0.name") ? true : undefined}
          />
          {fieldError("items.0.name") && <span className="error">{fieldError("items.0.name")}</span>}
        </label>
        <label htmlFor="itemWeight">
          Gewicht kg <span className="muted">({messages.common.optional})</span>
          <input id="itemWeight" name="itemWeight" type="number" min="1" step="1" />
        </label>
        <label htmlFor="itemQuantity">
          Anzahl
          <input id="itemQuantity" name="itemQuantity" type="number" min="1" defaultValue={1} />
        </label>
        <label htmlFor="stairs">
          {messages.job.stairs}
          <input id="stairs" name="stairs" type="number" min="0" max="20" defaultValue={0} />
        </label>
      </div>

      <label className="checkbox" htmlFor="liftAvailable">
        <input id="liftAvailable" name="liftAvailable" type="checkbox" />
        <span>{messages.job.lift}</span>
      </label>

      <label htmlFor="notes">
        {messages.job.notes}
        <textarea id="notes" name="notes" placeholder="Zugang, Parken, Zustand, Frist" />
      </label>

      <FormError code={state.errorCode} messages={messages} />

      <SubmitButton pendingLabel={messages.customer.submitting}>
        {messages.customer.submit}
      </SubmitButton>
    </form>
  );
}
