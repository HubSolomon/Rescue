import { notFound } from "next/navigation";
import type { Evidence, Job } from "@rescue/contracts";
import { formatDate, getMessages, isLocale, type Locale } from "../../../../../i18n/index";
import { api, ApiError } from "../../../../../lib/api";
import { PROVIDER_ROLES, requireRole } from "../../../../../lib/auth";
import {
  CompleteJobForm,
  EvidenceUploadForm,
  StartJobForm
} from "../../../../../components/forms/provider-forms";
import {
  DefinitionList,
  LinkButton,
  PageHeader,
  Panel,
  StatusBadge
} from "../../../../../components/ui";

export default async function ProviderJobPage({
  params
}: {
  params: Promise<{ locale: string; id: string }>;
}) {
  const { locale: raw, id } = await params;
  if (!isLocale(raw)) notFound();
  const locale: Locale = raw;
  const messages = getMessages(locale);
  await requireRole(locale, ...PROVIDER_ROLES, "ADMIN");

  let job: Job;
  try {
    job = await api.get<Job>(`/v1/jobs/${id}`);
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) notFound();
    throw error;
  }

  let evidence: Evidence[] = [];
  try {
    evidence = await api.get<Evidence[]>(`/v1/jobs/${id}/evidence`);
  } catch {
    evidence = [];
  }
  const uploaded = evidence.filter((item) => item.status === "UPLOADED");

  return (
    <div className="layout">
      <div className="shell">
        <PageHeader
          eyebrow={messages.job.type[job.type]}
          title={job.customerReference || job.id.slice(0, 8)}
          actions={<StatusBadge status={job.status} messages={messages} />}
        />

        <div className="two-col">
          <div className="stack">
            <Panel title={messages.job.pickup}>
              <DefinitionList
                items={[
                  {
                    term: messages.job.pickup,
                    value: `${job.pickup.line1}, ${job.pickup.postalCode} ${job.pickup.city}`
                  },
                  ...(job.destination
                    ? [
                        {
                          term: messages.job.destination,
                          value: `${job.destination.line1}, ${job.destination.postalCode} ${job.destination.city}`
                        }
                      ]
                    : []),
                  {
                    term: messages.job.items,
                    value: job.items.map((item) => `${item.quantity} × ${item.name}`).join(", ")
                  },
                  { term: messages.job.stairs, value: String(job.stairs) },
                  {
                    term: messages.job.lift,
                    value: job.liftAvailable ? messages.common.yes : messages.common.no
                  },
                  ...(job.notes ? [{ term: messages.job.notes, value: job.notes }] : [])
                ]}
              />
            </Panel>

            {job.status === "ASSIGNED" && (
              <Panel>
                <StartJobForm locale={locale} messages={messages} jobId={job.id} />
              </Panel>
            )}

            {job.status === "IN_PROGRESS" && (
              <Panel>
                <CompleteJobForm
                  locale={locale}
                  messages={messages}
                  jobId={job.id}
                  hasEvidence={uploaded.length > 0}
                />
              </Panel>
            )}
          </div>

          <div className="stack">
            <Panel title={messages.provider.evidenceTitle}>
              <EvidenceUploadForm locale={locale} messages={messages} jobId={job.id} />
              {uploaded.length > 0 && (
                <ul className="plain-list">
                  {uploaded.map((item) => (
                    <li key={item.id}>
                      {messages.provider.evidenceKinds[item.kind]}{" "}
                      <span className="muted small">{formatDate(item.createdAt, locale)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </Panel>

            <LinkButton href={`/${locale}/provider`} variant="ghost">
              {messages.common.back}
            </LinkButton>
          </div>
        </div>
      </div>
    </div>
  );
}
