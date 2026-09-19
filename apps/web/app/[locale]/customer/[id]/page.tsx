import { notFound } from "next/navigation";
import type { Evidence, Job, JobEvent, Quote } from "@rescue/contracts";
import { formatDate, getMessages, isLocale, type Locale } from "../../../../i18n/index";
import { api, ApiError } from "../../../../lib/api";
import { CUSTOMER_ROLES, requireRole } from "../../../../lib/auth";
import { QuoteDecision } from "../../../../components/forms/quote-decision";
import {
  DefinitionList,
  EmptyState,
  LinkButton,
  Money,
  PageHeader,
  Panel,
  StatusBadge,
  SuccessNote
} from "../../../../components/ui";

async function safely<T>(promise: Promise<T>, fallback: T): Promise<T> {
  try {
    return await promise;
  } catch (error) {
    // A customer may legitimately have no access to a sub-resource yet; an
    // empty section is the right answer, not a crashed page.
    if (error instanceof ApiError && [403, 404].includes(error.status)) return fallback;
    throw error;
  }
}

export default async function CustomerJobPage({
  params,
  searchParams
}: {
  params: Promise<{ locale: string; id: string }>;
  searchParams: Promise<{ created?: string }>;
}) {
  const { locale: raw, id } = await params;
  if (!isLocale(raw)) notFound();
  const locale: Locale = raw;
  const messages = getMessages(locale);
  await requireRole(locale, ...CUSTOMER_ROLES, "ADMIN");
  const { created } = await searchParams;

  let job: Job;
  try {
    job = await api.get<Job>(`/v1/jobs/${id}`);
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) notFound();
    throw error;
  }

  const [quotes, evidence, events] = await Promise.all([
    safely(api.get<Quote[]>(`/v1/jobs/${id}/quotes`), []),
    safely(api.get<Evidence[]>(`/v1/jobs/${id}/evidence`), []),
    safely(api.get<JobEvent[]>(`/v1/jobs/${id}/events`), [])
  ]);

  const openQuote = quotes.find((quote) => quote.status === "SENT");
  const decidedQuote = quotes.find((quote) => quote.status === "APPROVED") ?? quotes.at(-1);
  const uploaded = evidence.filter((item) => item.status === "UPLOADED");
  const reference = job.customerReference || job.id.slice(0, 8);

  return (
    <div className="layout">
      <div className="shell">
        <PageHeader
          eyebrow={messages.job.type[job.type]}
          title={messages.customer.detailTitle.replace("{reference}", reference)}
          actions={<StatusBadge status={job.status} messages={messages} />}
        />

        {created && <SuccessNote>{messages.customer.created.replace("{reference}", reference)}</SuccessNote>}

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
                    value: job.items
                      .map((item) => `${item.quantity} × ${item.name}`)
                      .join(", ")
                  },
                  { term: messages.job.stairs, value: String(job.stairs) },
                  { term: messages.job.lift, value: job.liftAvailable ? messages.common.yes : messages.common.no },
                  ...(job.notes ? [{ term: messages.job.notes, value: job.notes }] : []),
                  { term: messages.job.created, value: formatDate(job.createdAt, locale) }
                ]}
              />
            </Panel>

            <Panel title={messages.customer.quote}>
              {!decidedQuote ? (
                <p className="muted">{messages.customer.quoteNone}</p>
              ) : (
                <>
                  <DefinitionList
                    items={[
                      {
                        term: messages.customer.quoteNet,
                        value: <Money cents={decidedQuote.netCents} locale={locale} />
                      },
                      {
                        term: messages.customer.quoteVat,
                        value: <Money cents={decidedQuote.vatCents} locale={locale} />
                      },
                      {
                        term: messages.customer.quoteGross,
                        value: (
                          <strong>
                            <Money cents={decidedQuote.grossCents} locale={locale} />
                          </strong>
                        )
                      },
                      {
                        term: messages.customer.quoteValidUntil,
                        value: formatDate(decidedQuote.validUntil, locale)
                      }
                    ]}
                  />
                  {openQuote ? (
                    <QuoteDecision
                      locale={locale}
                      messages={messages}
                      jobId={job.id}
                      quoteId={openQuote.id}
                    />
                  ) : (
                    <p className="muted">
                      {decidedQuote.status === "APPROVED"
                        ? messages.customer.approved
                        : decidedQuote.status === "REJECTED"
                          ? messages.customer.rejected
                          : ""}
                    </p>
                  )}
                </>
              )}
            </Panel>

            <Panel title={messages.customer.proof}>
              {uploaded.length === 0 ? (
                <p className="muted">{messages.customer.proofNone}</p>
              ) : (
                <ul className="plain-list">
                  {uploaded.map((item) => (
                    <li key={item.id} className="proof-row">
                      <span>
                        {messages.provider.evidenceKinds[item.kind]} ·{" "}
                        <span className="muted small">{formatDate(item.createdAt, locale)}</span>
                      </span>
                      {/* Points at our own route, not at storage: the signed
                          URL is minted server-side at click time and never
                          appears in this page's payload. */}
                      <a
                        className="button ghost small-button"
                        href={`/${locale}/proof/${item.id}`}
                        rel="noopener"
                        target="_blank"
                      >
                        {messages.customer.proofDownload}
                      </a>
                    </li>
                  ))}
                </ul>
              )}
            </Panel>
          </div>

          <div className="stack">
            <Panel title={messages.customer.assessment}>
              {job.status === "DRAFT" ? (
                <p className="muted">{messages.customer.assessmentPending}</p>
              ) : (
                <p className="muted">{messages.job.status[job.status]}</p>
              )}
            </Panel>

            <Panel title={messages.job.timeline}>
              {events.length === 0 ? (
                <EmptyState title={messages.common.none} body="" />
              ) : (
                <ol className="timeline">
                  {events.map((event) => (
                    <li key={event.id}>
                      <span className="timeline-dot" aria-hidden="true" />
                      <div>
                        <strong>{event.type}</strong>
                        <span className="muted small">{formatDate(event.createdAt, locale)}</span>
                      </div>
                    </li>
                  ))}
                </ol>
              )}
            </Panel>

            <LinkButton href={`/${locale}/customer`} variant="ghost">
              {messages.common.back}
            </LinkButton>
          </div>
        </div>
      </div>
    </div>
  );
}
