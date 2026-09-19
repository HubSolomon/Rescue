import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import "../globals.css";
import { getMessages, isLocale, otherLocale, type Locale } from "../../i18n/index";
import { currentUser, CUSTOMER_ROLES, DISPATCH_ROLES, hasRole, PROVIDER_ROLES } from "../../lib/auth";
import { SignOutButton } from "../../components/forms/sign-out";

export const metadata: Metadata = {
  title: "RESCUE Circular Logistics",
  description: "KI-gestützte Ausnahme- und Kreislauflogistik für Bremer Unternehmen."
};

export function generateStaticParams() {
  return [{ locale: "de" }, { locale: "en" }];
}

export default async function LocaleLayout({
  children,
  params
}: {
  children: React.ReactNode;
  params: Promise<{ locale: string }>;
}) {
  const { locale: raw } = await params;
  if (!isLocale(raw)) notFound();
  const locale: Locale = raw;
  const messages = getMessages(locale);
  const user = await currentUser();
  const other = otherLocale(locale);

  return (
    <html lang={locale}>
      <body>
        {/* First focusable element, so keyboard users can jump the nav. */}
        <a className="skip-link" href="#main">
          {messages.common.skipToContent}
        </a>

        <header className="nav">
          <div className="shell nav-inner">
            <Link className="brand" href={`/${locale}`}>
              <span className="mark" aria-hidden="true" />
              <span>{messages.common.appName}</span>
            </Link>

            <nav className="nav-links" aria-label={messages.nav.console}>
              {user && hasRole(user, ...CUSTOMER_ROLES) && (
                <Link href={`/${locale}/customer`}>{messages.nav.customer}</Link>
              )}
              {user && hasRole(user, ...DISPATCH_ROLES, "COMPLIANCE") && (
                <Link href={`/${locale}/dispatch`}>{messages.nav.dispatch}</Link>
              )}
              {user && hasRole(user, ...PROVIDER_ROLES) && (
                <>
                  <Link href={`/${locale}/provider`}>{messages.nav.provider}</Link>
                  <Link href={`/${locale}/provider/fleet`}>{messages.nav.fleet}</Link>
                </>
              )}

              <Link className="locale-toggle" href={`/${other}`} hrefLang={other} lang={other}>
                {other === "de" ? messages.common.german : messages.common.english}
              </Link>

              {user ? (
                <span className="who">
                  <span className="who-name">{user.user.name}</span>
                  <SignOutButton label={messages.common.signOut} locale={locale} />
                </span>
              ) : (
                <Link className="button" href={`/${locale}/sign-in`}>
                  {messages.common.signIn}
                </Link>
              )}
            </nav>
          </div>
        </header>

        <main id="main">{children}</main>

        <footer className="footer">
          <div className="shell">
            {messages.common.appName} · {messages.common.tagline}
          </div>
        </footer>
      </body>
    </html>
  );
}
