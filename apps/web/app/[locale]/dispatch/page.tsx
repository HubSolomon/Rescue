import Link from "next/link";
import { notFound } from "next/navigation";
import type { Job } from "@rescue/contracts";
import { formatDate, getMessages, isLocale } from "../../../i18n/index";
import { getWithMeta } from "../../../lib/api";
import { DISPATCH_ROLES, requireRole } from "../../../lib/auth";
import { EmptyState, PageHeader, Panel, StatusBadge } from "../../../components/ui";

export default async function DispatchPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const messages = getMessages(locale);
  await requireRole(locale, ...DISPATCH_ROLES, "COMPLIANCE");

  const { data: jobs } = await getWithMeta<Job[]>("/v1/jobs?limit=100");
  const queue = jobs.filter((job) => job.status === "DRAFT");
  const active = jobs.filter((job) =>
    ["TRIAGED", "QUOTED", "ASSIGNED", "IN_PROGRESS"].includes(job.status)
  );
  const rest = jobs.filter((job) => ["COMPLETED", "CANCELLED"].includes(job.status));

  const row = (job: Job) => (
    <li key={job.id}>
      <Link className="job-row" href={`/${locale}/dispatch/${job.id}`}>
        <span className="job-row-main">
          <strong>{job.customerReference || job.id.slice(0, 8)}</strong>
          <span className="muted">
            {messages.job.type[job.type]} · {messages.job.urgency[job.urgency]} · {job.pickup.postalCode}{" "}
            {job.pickup.city}
          </span>
        </span>
        <span className="job-row-meta">
          <StatusBadge status={job.status} messages={messages} />
          <span className="muted small">{formatDate(job.createdAt, locale)}</span>
        </span>
      </Link>
    </li>
  );

  return (
    <div className="layout">
      <div className="shell">
        <PageHeader title={messages.dispatch.title} lead={messages.dispatch.lead} />

        <div className="dashboard-grid">
          <div className="metric">
            <strong>{queue.length}</strong>
            {messages.dispatch.queueTitle}
          </div>
          <div className="metric">
            <strong>{active.length}</strong>
            {messages.dispatch.activeTitle}
          </div>
          <div className="metric">
            <strong>{jobs.filter((job) => job.status === "COMPLETED").length}</strong>
            {messages.job.status.COMPLETED}
          </div>
          <div className="metric">
            <strong>{jobs.length}</strong>
            {messages.dispatch.allTitle}
          </div>
        </div>

        <Panel title={messages.dispatch.queueTitle}>
          {queue.length === 0 ? (
            <EmptyState title={messages.dispatch.queueEmpty} body="" />
          ) : (
            <ul className="job-list">{queue.map(row)}</ul>
          )}
        </Panel>

        <Panel title={messages.dispatch.activeTitle}>
          {active.length === 0 ? (
            <EmptyState title={messages.dispatch.queueEmpty} body="" />
          ) : (
            <ul className="job-list">{active.map(row)}</ul>
          )}
        </Panel>

        {rest.length > 0 && (
          <Panel title={messages.dispatch.allTitle}>
            <ul className="job-list">{rest.map(row)}</ul>
          </Panel>
        )}
      </div>
    </div>
  );
}
