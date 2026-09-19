"use client";

import { useActionState, useState } from "react";
import { decideQuoteAction, type FormState } from "../../lib/actions/jobs";
import { SubmitButton } from "./submit-button";
import { FormError, SuccessNote } from "../ui";
import type { Locale, Messages } from "../../i18n/index";

/**
 * Approving a quote is a financial commitment, so rejection asks for a reason
 * and approval is a separate, deliberate button rather than a dropdown.
 */
export function QuoteDecision({
  locale,
  messages,
  jobId,
  quoteId
}: {
  locale: Locale;
  messages: Messages;
  jobId: string;
  quoteId: string;
}) {
  const [state, formAction] = useActionState<FormState, FormData>(decideQuoteAction, {});
  const [rejecting, setRejecting] = useState(false);

  if (state.ok) {
    return <SuccessNote>{messages.customer.approved}</SuccessNote>;
  }

  return (
    <form action={formAction} className="form inline-form">
      <input type="hidden" name="locale" value={locale} />
      <input type="hidden" name="jobId" value={jobId} />
      <input type="hidden" name="quoteId" value={quoteId} />

      {rejecting && (
        <label htmlFor="reject-reason">
          {messages.customer.rejectReason}
          <textarea id="reject-reason" name="reason" required minLength={3} />
        </label>
      )}

      <FormError code={state.errorCode} messages={messages} />

      <div className="actions">
        {!rejecting && (
          <SubmitButton
            name="decision"
            value="APPROVE"
            pendingLabel={messages.customer.approving}
          >
            {messages.customer.approve}
          </SubmitButton>
        )}
        {rejecting ? (
          <>
            <SubmitButton
              name="decision"
              value="REJECT"
              variant="secondary"
              pendingLabel={messages.customer.approving}
            >
              {messages.customer.reject}
            </SubmitButton>
            <button type="button" className="button ghost" onClick={() => setRejecting(false)}>
              {messages.common.cancel}
            </button>
          </>
        ) : (
          <button type="button" className="button ghost" onClick={() => setRejecting(true)}>
            {messages.customer.reject}
          </button>
        )}
      </div>
    </form>
  );
}
