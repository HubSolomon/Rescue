"use client";

import { useActionState } from "react";
import { signInAction, type ActionState } from "../../lib/actions/session";
import { SubmitButton } from "./submit-button";
import { errorMessage } from "../ui";
import type { Locale, Messages } from "../../i18n/index";

/** The seeded development accounts, one per role the console supports. */
const ACCOUNTS = [
  { subject: "dev|customer-admin", name: "Katrin Vogel", org: "Nordlicht Möbel GmbH", role: "CUSTOMER_ADMIN" },
  { subject: "dev|customer-member", name: "Tobias Reimer", org: "Nordlicht Möbel GmbH", role: "CUSTOMER_MEMBER" },
  { subject: "dev|other-customer", name: "Lena Brandt", org: "Weser Tech AG", role: "CUSTOMER_ADMIN" },
  { subject: "dev|dispatcher", name: "Sven Kohl", org: "RESCUE", role: "DISPATCHER" },
  { subject: "dev|compliance", name: "Miriam Falk", org: "RESCUE", role: "COMPLIANCE" },
  { subject: "dev|provider-hansa", name: "Jörg Petersen", org: "Hansa Transport UG", role: "PROVIDER_ADMIN" },
  { subject: "dev|provider-roland", name: "Annika Schuster", org: "Roland Logistik GmbH", role: "PROVIDER_ADMIN" },
  { subject: "dev|admin", name: "Platform Admin", org: "RESCUE", role: "ADMIN" }
] as const;

export function SignInForm({ locale, messages }: { locale: Locale; messages: Messages }) {
  const [state, formAction] = useActionState<ActionState, FormData>(signInAction, {});

  return (
    <form action={formAction} className="form">
      <input type="hidden" name="locale" value={locale} />

      <fieldset className="accounts">
        <legend className="sr-only">{messages.signIn.title}</legend>
        {ACCOUNTS.map((account, index) => (
          <label className="account" key={account.subject}>
            <input
              type="radio"
              name="subject"
              value={account.subject}
              defaultChecked={index === 0}
              required
            />
            <span>
              <strong>{account.name}</strong>
              <span className="muted">
                {account.org} · {messages.roles[account.role]}
              </span>
            </span>
          </label>
        ))}
      </fieldset>

      {state.errorCode && (
        <p className="error" role="alert">
          {state.errorCode === "NETWORK"
            ? messages.signIn.failed
            : errorMessage(state.errorCode, messages)}
        </p>
      )}

      <SubmitButton pendingLabel={messages.common.loading}>{messages.signIn.submit}</SubmitButton>
    </form>
  );
}
