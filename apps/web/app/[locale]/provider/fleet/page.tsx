import { notFound } from "next/navigation";
import type { ProviderDocument, Vehicle } from "@rescue/contracts";
import { formatDateOnly, getMessages, isLocale, type Locale } from "../../../../i18n/index";
import { api, ApiError } from "../../../../lib/api";
import { PROVIDER_ROLES, requireRole } from "../../../../lib/auth";
import { AddDocumentForm, AddVehicleForm } from "../../../../components/forms/provider-forms";
import { EmptyState, LinkButton, PageHeader, Panel, Tag } from "../../../../components/ui";

async function safely<T>(promise: Promise<T>, fallback: T): Promise<T> {
  try {
    return await promise;
  } catch (error) {
    if (error instanceof ApiError && [400, 403, 404].includes(error.status)) return fallback;
    throw error;
  }
}

export default async function FleetPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale: raw } = await params;
  if (!isLocale(raw)) notFound();
  const locale: Locale = raw;
  const messages = getMessages(locale);
  const user = await requireRole(locale, ...PROVIDER_ROLES, "ADMIN");

  const providerId = user.activeProviderId;
  if (!providerId) {
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

  const [vehicles, documents] = await Promise.all([
    safely(api.get<Vehicle[]>(`/v1/providers/${providerId}/vehicles`), []),
    safely(api.get<ProviderDocument[]>(`/v1/providers/${providerId}/documents`), [])
  ]);

  const documentTone = (status: ProviderDocument["status"]) =>
    status === "VERIFIED" ? "good" : status === "REJECTED" || status === "EXPIRED" ? "bad" : "neutral";

  return (
    <div className="layout">
      <div className="shell">
        <PageHeader title={messages.provider.fleetTitle} />

        <div className="two-col">
          <div className="stack">
            <Panel title={messages.provider.vehicles}>
              {vehicles.length === 0 ? (
                <EmptyState title={messages.provider.vehiclesEmpty} body="" />
              ) : (
                <ul className="plain-list">
                  {vehicles.map((vehicle) => (
                    <li key={vehicle.id}>
                      <strong>{messages.job.vehicle[vehicle.vehicleClass]}</strong> ·{" "}
                      {vehicle.payloadKg} kg · {vehicle.volumeM3} m³{" "}
                      {!vehicle.active && <Tag tone="muted">{messages.common.no}</Tag>}
                    </li>
                  ))}
                </ul>
              )}
            </Panel>
            <Panel title={messages.provider.addVehicle}>
              <AddVehicleForm locale={locale} messages={messages} providerId={providerId} />
            </Panel>
          </div>

          <div className="stack">
            <Panel title={messages.provider.documents}>
              {documents.length === 0 ? (
                <EmptyState title={messages.provider.documentsEmpty} body="" />
              ) : (
                <ul className="plain-list">
                  {documents.map((document) => (
                    <li key={document.id}>
                      <strong>{messages.provider.documentTypes[document.type]}</strong>{" "}
                      <Tag tone={documentTone(document.status)}>
                        {messages.provider.documentStatus[document.status]}
                      </Tag>
                      {document.expiresAt && (
                        <span className="muted small">
                          {" "}
                          {messages.provider.documentExpiry}{" "}
                          {formatDateOnly(document.expiresAt, locale)}
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </Panel>
            <Panel title={messages.provider.addDocument}>
              <AddDocumentForm locale={locale} messages={messages} providerId={providerId} />
            </Panel>
          </div>
        </div>
      </div>
    </div>
  );
}
