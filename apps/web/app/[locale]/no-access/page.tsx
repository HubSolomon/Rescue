import { notFound } from "next/navigation";
import { getMessages, isLocale } from "../../../i18n/index";
import { ErrorState, LinkButton } from "../../../components/ui";

export default async function NoAccessPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const messages = getMessages(locale);

  return (
    <div className="layout">
      <div className="shell narrow">
        <ErrorState
          title={messages.common.unauthorisedTitle}
          body={messages.common.unauthorisedBody}
          retry={<LinkButton href={`/${locale}`}>{messages.common.back}</LinkButton>}
        />
      </div>
    </div>
  );
}
