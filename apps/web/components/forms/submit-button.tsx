"use client";
import { useFormStatus } from "react-dom";

/**
 * Disables itself while the action is in flight, so a double click cannot fire
 * the mutation twice. The API's idempotency key is the real guarantee; this is
 * the visible half of it.
 */
export function SubmitButton({
  children,
  pendingLabel,
  variant = "primary",
  name,
  value
}: {
  children: React.ReactNode;
  pendingLabel?: string;
  variant?: "primary" | "secondary" | "ghost";
  name?: string;
  value?: string;
}) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      name={name}
      value={value}
      className={`button ${variant === "primary" ? "" : variant}`}
      disabled={pending}
      aria-busy={pending}
    >
      {pending && pendingLabel ? pendingLabel : children}
    </button>
  );
}
