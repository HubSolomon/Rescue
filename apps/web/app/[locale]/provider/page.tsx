import Link from "next/link";
import { notFound } from "next/navigation";
import type { AssignmentOffer, Job, Provider } from "@rescue/contracts";
import { formatRelative, getMessages, isLocale, type Locale } from "../../../i18n/index";
import { api, ApiError } from "../../../lib/api";
import { PROVIDER_ROLES, requireRole } from "../../../lib/auth";
import { OfferResponse } from "../../../components/forms/provider-forms";
import {
  EmptyState,
  LinkButton,
  Money,
  PageHeader,
  Panel,
  StatusBadge,
  Tag
} from "../../../components/ui";

async function safely<T>(promise: Promise<T>, fallback: T): Promise<T> {
  try {
    return await promise;
  } catch (error) {
    if (error instanceof ApiError && [400, 403, 404].includes(error.status)) return fallback;
    throw error;
  }
}

export default async function ProviderInboxPage({
  params
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale: raw } = await params;
  if (!isLocale(raw)) notFound();
  const locale: Locale = raw;
  const messages = getMessages(locale);
  const user = await requireRole(locale, ...PROVIDER_ROLES, "ADMIN");

  if (!user.activeProviderId) {
    return (
      <div className="layout">
        <div className="shell narrow">
          <EmptyState
            title={messages.provider.onboardingTitle}
            body={messages.provider.onboardingPending}
            action={
              <LinkButton href={`/${locale}/provider/onboarding`}>
                {messages.provider.onboardingSubmit}
              </LinkButton>
            }
          />
        </div>
      </div>
    );
  }

  const offers = await safely(api.get<AssignmentOffer[]>("/v1/offers?status=PENDING"), []);
  const allJobs = await safely(api.get<Job[]>("/v1/jobs?limit=50"), []);
  const provider = await safely<Provider | null>(
    api.get<Provider>(`/v1/providers/${user.activeProviderId}`),
    null
  );
  const myJobs = allJobs.filter((job) => ["ASSIGNED", "IN_PROGRESS"].includes(job.status));
  const now = new Date();

  return (
    <div className="layout">
      <div className="shell">
        <PageHeader title={messages.provider.inboxTitle} lead={messages.provider.inboxLead} />

        {/* An empty inbox has two very different causes. Say which one it is
            here rather than leaving the provider to wonder why it is quiet. */}
        {provider && !provider.acceptingWork && (
          <p className="callout">
            <strong>{messages.provider.availabilityOff}</strong>{" "}
            {messages.provider.availabilityLead}{" "}
            <Link className="locale-toggle" href={`/${locale}/provider/fleet`}>
              {messages.provider.availabilityResume}
            </Link>
          </p>
        )}

        {offers.length === 0 ? (
          <EmptyState title={messages.provider.inboxEmpty} body="" />
        ) : (
          <ul className="offer-list">
            {offers.map((offer) => {
              const expired = new Date(offer.expiresAt).getTime() <= now.getTime();
              return (
                <li key={offer.id}>
                  <Panel as="article">
                    <div className="offer-head">
                      <div>
                        <strong>
                          {messages.provider.payout}: <Money cents={offer.payoutNetCents} locale={locale} />
                        </strong>
                        <p className="muted small">
                          {messages.provider.expiresIn} {formatRelative(offer.expiresAt, locale, now)}
                        </p>
                      </div>
                      {expired && <Tag tone="muted">{messages.provider.expired}</Tag>}
                    </div>
                    <OfferResponse
                      locale={locale}
                      messages={messages}
                      offerId={offer.id}
                      expired={expired}
                    />
                  </Panel>
                </li>
              );
            })}
          </ul>
        )}

        <Panel title={messages.provider.jobsTitle}>
          {myJobs.length === 0 ? (
            <EmptyState title={messages.provider.inboxEmpty} body="" />
          ) : (
            <ul className="job-list">
              {myJobs.map((job) => (
                <li key={job.id}>
                  <Link className="job-row" href={`/${locale}/provider/jobs/${job.id}`}>
                    <span className="job-row-main">
                      <strong>{job.customerReference || job.id.slice(0, 8)}</strong>
                      <span className="muted">
                        {job.pickup.postalCode} {job.pickup.city}
                      </span>
                    </span>
                    <StatusBadge status={job.status} messages={messages} />
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>
    </div>
  );
}
