import Link from "next/link";
import { notFound } from "next/navigation";
import { getMessages, isLocale } from "../../i18n/index";
import { currentUser, homePathFor } from "../../lib/auth";

export default async function HomePage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const messages = getMessages(locale);
  const user = await currentUser();
  const consoleHref = user ? homePathFor(user, locale) : `/${locale}/sign-in`;

  return (
    <>
      <section className="hero">
        <div className="shell hero-grid">
          <div>
            <p className="eyebrow">{messages.landing.eyebrow}</p>
            <h1>{messages.landing.headline}</h1>
            <p className="lead">{messages.landing.lead}</p>
            <div className="actions">
              <Link className="button" href={`${user ? `/${locale}/customer/new` : consoleHref}`}>
                {messages.landing.ctaRequest}
              </Link>
              <Link className="button ghost" href={consoleHref}>
                {messages.landing.ctaDashboard}
              </Link>
            </div>
          </div>

          <div className="panel" aria-label="Beispiel">
            <h3>Recovery #RSC-1042</h3>
            <div className="status">
              <span>{messages.job.type.FAILED_DELIVERY}</span>
              <span className="badge tone-neutral">{messages.job.status.DRAFT}</span>
            </div>
            <div className="status">
              <span>{messages.customer.assessment}</span>
              <span className="badge tone-info">{messages.job.status.TRIAGED}</span>
            </div>
            <div className="status">
              <span>{messages.dispatch.eligibilityTitle}</span>
              <span className="badge tone-progress">{messages.job.status.ASSIGNED}</span>
            </div>
            <div className="status">
              <span>{messages.customer.proof}</span>
              <span className="badge tone-good">{messages.job.status.COMPLETED}</span>
            </div>
          </div>
        </div>
      </section>

      <section className="section pale">
        <div className="shell">
          <p className="eyebrow">{messages.landing.fleetEyebrow}</p>
          <h2>{messages.landing.fleetTitle}</h2>
          <p className="lead">{messages.landing.fleetBody}</p>
          {/* Both liveries, because a customer and a provider see different
              vans arrive and both are RESCUE. */}
          <div className="livery-pair" style={{ marginTop: 32 }}>
            <figure className="livery">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src="/brand/van-navy.jpg"
                alt={messages.landing.fleetNavyAlt}
                width={1200}
                height={800}
              />
              <figcaption>{messages.landing.fleetNavy}</figcaption>
            </figure>
            <figure className="livery">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src="/brand/van-white.jpg"
                alt={messages.landing.fleetWhiteAlt}
                width={1200}
                height={800}
              />
              <figcaption>{messages.landing.fleetWhite}</figcaption>
            </figure>
          </div>
        </div>
      </section>

      <section className="section">
        <div className="shell">
          <p className="eyebrow">{messages.landing.workflowsEyebrow}</p>
          <h2>{messages.landing.workflowsTitle}</h2>
          <div className="grid3">
            <article className="card">
              <h3>{messages.landing.deliveryTitle}</h3>
              <p>{messages.landing.deliveryBody}</p>
            </article>
            <article className="card">
              <h3>{messages.landing.returnTitle}</h3>
              <p>{messages.landing.returnBody}</p>
            </article>
            <article className="card">
              <h3>{messages.landing.surplusTitle}</h3>
              <p>{messages.landing.surplusBody}</p>
            </article>
          </div>
        </div>
      </section>

      <section className="section pale">
        <div className="shell">
          <p className="eyebrow">{messages.landing.accountableEyebrow}</p>
          <h2>{messages.landing.accountableTitle}</h2>
          <p className="lead">{messages.landing.accountableBody}</p>
        </div>
      </section>
    </>
  );
}
