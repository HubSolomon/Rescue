import { notFound } from "next/navigation";
import { getMessages, isLocale } from "../../../../i18n/index";
import { PROVIDER_ROLES, requireRole } from "../../../../lib/auth";
import { ProviderOnboardingForm } from "../../../../components/forms/provider-forms";
import { PageHeader, Panel } from "../../../../components/ui";

export default async function ProviderOnboardingPage({
  params
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const messages = getMessages(locale);
  await requireRole(locale, ...PROVIDER_ROLES, "ADMIN", "DISPATCHER");

  return (
    <div className="layout">
      <div className="shell narrow">
        <PageHeader
          title={messages.provider.onboardingTitle}
          lead={messages.provider.onboardingPending}
        />
        <Panel>
          <ProviderOnboardingForm locale={locale} messages={messages} />
        </Panel>
      </div>
    </div>
  );
}
