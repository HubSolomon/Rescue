import { notFound } from "next/navigation";
import { getMessages, isLocale } from "../../../../i18n/index";
import { CUSTOMER_ROLES, requireRole } from "../../../../lib/auth";
import { NewRequestForm } from "../../../../components/forms/new-request-form";
import { PageHeader, Panel } from "../../../../components/ui";

export default async function NewRequestPage({
  params
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const messages = getMessages(locale);
  await requireRole(locale, ...CUSTOMER_ROLES, "ADMIN");

  return (
    <div className="layout">
      <div className="shell narrow">
        <PageHeader
          eyebrow={messages.nav.newRequest}
          title={messages.customer.newTitle}
          lead={messages.customer.newLead}
        />
        <Panel>
          <NewRequestForm locale={locale} messages={messages} />
        </Panel>
      </div>
    </div>
  );
}
