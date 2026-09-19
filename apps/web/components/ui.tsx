import type { ReactNode } from "react";
import Link from "next/link";
import type { JobStatus } from "@rescue/contracts";
import type { Locale, Messages } from "../i18n/index";

/* ------------------------------------------------------------------ layout */

export function PageHeader({
  eyebrow,
  title,
  lead,
  actions
}: {
  eyebrow?: string;
  title: string;
  lead?: string;
  actions?: ReactNode;
}) {
  return (
    <header className="page-header">
      <div>
        {eyebrow && <p className="eyebrow">{eyebrow}</p>}
        <h2>{title}</h2>
        {lead && <p className="lead">{lead}</p>}
      </div>
      {actions && <div className="actions">{actions}</div>}
    </header>
  );
}

export function Panel({
  title,
  description,
  children,
  as: Tag = "section"
}: {
  title?: string;
  description?: string;
  children: ReactNode;
  as?: "section" | "div" | "article";
}) {
  return (
    <Tag className="panel">
      {title && <h3>{title}</h3>}
      {description && <p className="muted">{description}</p>}
      {children}
    </Tag>
  );
}

/* ------------------------------------------------------------------ states */

/**
 * Empty, error and loading states are components rather than ad-hoc markup so
 * every list looks the same when it has nothing to show. The Phase 3 brief
 * asks for all four states on every surface.
 */
export function EmptyState({
  title,
  body,
  action
}: {
  title: string;
  body: string;
  action?: ReactNode;
}) {
  return (
    <div className="state" role="status">
      <h3>{title}</h3>
      <p className="muted">{body}</p>
      {action}
    </div>
  );
}

export function ErrorState({
  title,
  body,
  retry
}: {
  title: string;
  body: string;
  retry?: ReactNode;
}) {
  return (
    <div className="state state-error" role="alert">
      <h3>{title}</h3>
      <p>{body}</p>
      {retry}
    </div>
  );
}

export function Skeleton({ rows = 3, label }: { rows?: number; label: string }) {
  return (
    <div className="skeleton-group" role="status" aria-live="polite" aria-busy="true">
      <span className="sr-only">{label}</span>
      {Array.from({ length: rows }, (_, index) => (
        <div className="skeleton" key={index} aria-hidden="true" />
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ status */

/** Status colour is backed by text, never colour alone (WCAG 1.4.1). */
const STATUS_TONE: Record<JobStatus, string> = {
  DRAFT: "tone-neutral",
  TRIAGED: "tone-info",
  QUOTED: "tone-info",
  ASSIGNED: "tone-progress",
  IN_PROGRESS: "tone-progress",
  COMPLETED: "tone-good",
  CANCELLED: "tone-muted"
};

export function StatusBadge({ status, messages }: { status: JobStatus; messages: Messages }) {
  return <span className={`badge ${STATUS_TONE[status]}`}>{messages.job.status[status]}</span>;
}

export function Tag({ children, tone = "neutral" }: { children: ReactNode; tone?: string }) {
  return <span className={`badge tone-${tone}`}>{children}</span>;
}

/* -------------------------------------------------------------------- data */

export function DefinitionList({ items }: { items: { term: string; value: ReactNode }[] }) {
  return (
    <dl className="definitions">
      {items.map((item) => (
        <div key={item.term}>
          <dt>{item.term}</dt>
          <dd>{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function LinkButton({
  href,
  children,
  variant = "primary"
}: {
  href: string;
  children: ReactNode;
  variant?: "primary" | "secondary" | "ghost";
}) {
  return (
    <Link className={`button ${variant === "primary" ? "" : variant}`} href={href}>
      {children}
    </Link>
  );
}

/* ------------------------------------------------------------------ errors */

/** Maps an API error code to localised copy, falling back to a generic line. */
export function errorMessage(code: string | undefined, messages: Messages): string {
  const table = messages.errors as Record<string, string>;
  return (code && table[code]) || messages.errors.UNKNOWN;
}

export function FormError({ code, messages }: { code?: string; messages: Messages }) {
  if (!code) return null;
  return (
    <p className="error" role="alert">
      {errorMessage(code, messages)}
    </p>
  );
}

export function SuccessNote({ children }: { children: ReactNode }) {
  return (
    <p className="success" role="status">
      {children}
    </p>
  );
}

/* ------------------------------------------------------------- formatting */

export function Money({ cents, locale }: { cents: number; locale: Locale }) {
  return (
    <span className="numeric">
      {new Intl.NumberFormat(locale === "de" ? "de-DE" : "en-IE", {
        style: "currency",
        currency: "EUR"
      }).format(cents / 100)}
    </span>
  );
}
