import { notFound } from "next/navigation";
import type {
  AssignmentOffer,
  EligibilityResult,
  Job,
  JobEvent,
  Quote
} from "@rescue/contracts";
import {
  formatDate,
  formatRelative,
  getMessages,
  isLocale,
  type Locale
} from "../../../../i18n/index";
import { api, ApiError } from "../../../../lib/api";
import { DISPATCH_ROLES, requireRole } from "../../../../lib/auth";
import {
  ApproveTriageForm,
  CreateOffersForm,
  CreateQuoteForm,
  FallbackForm
} from "../../../../components/forms/dispatch-forms";
import {
  DefinitionList,
  LinkButton,
  Money,
  PageHeader,
  Panel,
  StatusBadge,
  Tag
} from "../../../../components/ui";

async function safely<T>(promise: Promise<T>, fallback: T): Promise<T> {
  try {
    return await promise;
  } catch (error) {
    if (error instanceof ApiError && [400, 403, 404, 409].includes(error.status)) return fallback;
    throw error;
  }
}

export default async function DispatchJobPage({
  params
}: {
  params: Promise<{ locale: string; id: string }>;
}) {
  const { locale: raw, id } = await params;
  if (!isLocale(raw)) notFound();
  const locale: Locale = raw;
  const messages = getMessages(locale);
  await requireRole(locale, ...DISPATCH_ROLES);

  let job: Job;
  try {
    job = await api.get<Job>(`/v1/jobs/${id}`);
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) notFound();
    throw error;
  }

  const [quotes, offers, eligibility, events] = await Promise.all([
    safely(api.get<Quote[]>(`/v1/jobs/${id}/quotes`), []),
    safely(api.get<AssignmentOffer[]>(`/v1/jobs/${id}/offers`), []),
    safely(api.get<EligibilityResult[]>(`/v1/jobs/${id}/eligible-providers`), []),
    safely(api.get<JobEvent[]>(`/v1/jobs/${id}/events`), [])
  ]);

  const approvedQuote = quotes.find((quote) => quote.status === "APPROVED");
  const reference = job.customerReference || job.id.slice(0, 8);
  const eligibleCount = eligibility.filter((result) => result.eligible).length;

  return (
    <div className="layout">
      <div className="shell">
        <PageHeader
          eyebrow={`${messages.job.type[job.type]} · ${messages.job.urgency[job.urgency]}`}
          title={reference}
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

            {job.status === "DRAFT" && (
              <Panel
                title={messages.dispatch.approveTriage}
                description={messages.dispatch.approveTriageLead}
              >
                <ApproveTriageForm locale={locale} messages={messages} jobId={job.id} />
              </Panel>
            )}

            {job.status === "TRIAGED" && (
              <Panel title={messages.dispatch.quoteTitle}>
                <CreateQuoteForm locale={locale} messages={messages} jobId={job.id} />
              </Panel>
            )}

            {job.status === "QUOTED" && approvedQuote && (
              <Panel title={messages.dispatch.offersTitle}>
                <CreateOffersForm locale={locale} messages={messages} jobId={job.id} />
              </Panel>
            )}

            {(job.status === "ASSIGNED" || job.status === "IN_PROGRESS") && (
              <Panel title={messages.dispatch.fallbackTitle}>
                <FallbackForm locale={locale} messages={messages} jobId={job.id} />
              </Panel>
            )}

            <Panel
              title={`${messages.dispatch.eligibilityTitle} (${eligibleCount})`}
              description={messages.dispatch.eligibilityLead}
            >
              {eligibility.length === 0 ? (
                <p className="muted">{messages.common.none}</p>
              ) : (
                <ul className="plain-list eligibility">
                  {eligibility.map((result) => (
                    <li key={result.providerId} className={result.eligible ? "is-eligible" : ""}>
                      <span className="eligibility-head">
                        <code>{result.providerId.slice(0, 8)}</code>
                        {result.eligible ? (
                          <Tag tone="good">
                            {messages.dispatch.eligible} · {messages.dispatch.rank} {result.rank}
                          </Tag>
                        ) : (
                          <Tag tone="muted">{messages.dispatch.notEligible}</Tag>
                        )}
                        {result.distanceKm !== null && (
                          <span className="muted small">
                            {messages.dispatch.distance}: {result.distanceKm} km
                          </span>
                        )}
                      </span>
                      {result.reasons.length > 0 && (
                        <ul className="reasons">
                          {result.reasons.map((reason) => (
                            <li key={reason}>{messages.dispatch.reasons[reason]}</li>
                          ))}
                        </ul>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </Panel>
          </div>

          <div className="stack">
            <Panel title={messages.customer.quote}>
              {quotes.length === 0 ? (
                <p className="muted">{messages.customer.quoteNone}</p>
              ) : (
                <ul className="plain-list">
                  {quotes.map((quote) => (
                    <li key={quote.id}>
                      <Money cents={quote.grossCents} locale={locale} />{" "}
                      <Tag tone={quote.status === "APPROVED" ? "good" : "neutral"}>
                        {quote.status}
                      </Tag>
                      <span className="muted small">
                        {" "}
                        {messages.customer.quoteValidUntil} {formatDate(quote.validUntil, locale)}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </Panel>

            <Panel title={messages.dispatch.offersTitle}>
              {offers.length === 0 ? (
                <p className="muted">{messages.dispatch.offersNone}</p>
              ) : (
                <ul className="plain-list">
                  {offers.map((offer) => (
                    <li key={offer.id}>
                      <code>{offer.providerId.slice(0, 8)}</code> ·{" "}
                      <Money cents={offer.payoutNetCents} locale={locale} /> ·{" "}
                      <Tag tone={offer.status === "ACCEPTED" ? "good" : "neutral"}>
                        {offer.status}
                      </Tag>
                      <span className="muted small">
                        {" "}
                        {formatRelative(offer.expiresAt, locale)}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </Panel>

            <Panel title={messages.job.timeline}>
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
            </Panel>

            <LinkButton href={`/${locale}/dispatch`} variant="ghost">
              {messages.common.back}
            </LinkButton>
          </div>
        </div>
      </div>
    </div>
  );
}
