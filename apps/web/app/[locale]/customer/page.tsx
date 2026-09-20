import Link from "next/link";
import { notFound } from "next/navigation";
import type { Job } from "@rescue/contracts";
import { formatDate, getMessages, isLocale } from "../../../i18n/index";
import { getWithMeta } from "../../../lib/api";
import { CUSTOMER_ROLES, requireRole } from "../../../lib/auth";
import { EmptyState, LinkButton, PageHeader, StatusBadge } from "../../../components/ui";

export default async function CustomerJobsPage({
  params
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const messages = getMessages(locale);
  await requireRole(locale, ...CUSTOMER_ROLES, "ADMIN");

  const { data: jobs } = await getWithMeta<Job[]>("/v1/jobs?limit=50");

  return (
    <div className="layout">
      <div className="shell">
        <PageHeader
          title={messages.customer.listTitle}
          lead={messages.customer.listLead}
          actions={
            <LinkButton href={`/${locale}/customer/new`}>{messages.nav.newRequest}</LinkButton>
          }
        />

        {jobs.length === 0 ? (
          <EmptyState
            title={messages.customer.emptyTitle}
            body={messages.customer.emptyBody}
            action={
              <LinkButton href={`/${locale}/customer/new`}>
                {messages.customer.emptyCta}
              </LinkButton>
            }
          />
        ) : (
          <ul className="job-list">
            {jobs.map((job) => (
              <li key={job.id}>
                <Link className="job-row" href={`/${locale}/customer/${job.id}`}>
                  <span className="job-row-main">
                    <strong>{job.customerReference || job.id.slice(0, 8)}</strong>
                    <span className="muted">
                      {messages.job.type[job.type]} · {job.pickup.city}
                    </span>
                  </span>
                  <span className="job-row-meta">
                    <StatusBadge status={job.status} messages={messages} />
                    <span className="muted small">{formatDate(job.createdAt, locale)}</span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
