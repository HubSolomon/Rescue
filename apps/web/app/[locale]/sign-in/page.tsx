import { notFound } from "next/navigation";
import { getMessages, isLocale } from "../../../i18n/index";
import { SignInForm } from "../../../components/forms/sign-in-form";
import { PageHeader, Panel } from "../../../components/ui";

export default async function SignInPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const messages = getMessages(locale);

  return (
    <div className="layout">
      <div className="shell narrow">
        <PageHeader title={messages.signIn.title} lead={messages.signIn.lead} />
        <p className="callout" role="note">
          {messages.signIn.devWarning}
        </p>
        <Panel>
          <SignInForm locale={locale} messages={messages} />
        </Panel>
      </div>
    </div>
  );
}
