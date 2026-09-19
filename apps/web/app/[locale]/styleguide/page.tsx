import type { Metadata } from "next";
import { notFound } from "next/navigation";
import type { JobStatus } from "@rescue/contracts";
import { jobStatuses } from "@rescue/contracts";
import { formatDate, getMessages, isLocale, type Locale } from "../../../i18n/index";
import {
  DefinitionList,
  EmptyState,
  ErrorState,
  FormError,
  LinkButton,
  Money,
  PageHeader,
  Panel,
  Skeleton,
  StatusBadge,
  SuccessNote,
  Tag
} from "../../../components/ui";

/**
 * The design system, rendered from the product's own stylesheet and its own
 * components.
 *
 * Deliberately a route rather than a separate document: a design system kept
 * anywhere else is a description of what the product looked like on the day
 * someone wrote it down. This page imports the same components the three
 * consoles import and inherits the same `globals.css`, so a token or a
 * component that changes here changes because the product changed.
 *
 * It is unauthenticated on purpose -- it contains no data, only shapes -- and
 * it is the one page in the app where seeing every state at once is the point.
 */

export const metadata: Metadata = {
  title: "RESCUE design system",
  // Not useful in a search index, and not part of the product surface.
  robots: { index: false, follow: false }
};

export function generateStaticParams() {
  return [{ locale: "de" }, { locale: "en" }];
}

/** Colour tokens, with the reason each one exists. */
const COLOURS = [
  { token: "--navy", value: "#0d2b44", use: "Headings, structure, the wordmark" },
  { token: "--green", value: "#0d9b67", use: "The mark and decorative shapes. Never text" },
  { token: "--green-strong", value: "#0b8458", use: "Buttons and green text. 4.7:1 with white" },
  { token: "--amber", value: "#f6a641", use: "Attention that is not yet failure" },
  { token: "--ink", value: "#1d2733", use: "Body text" },
  { token: "--muted", value: "#607080", use: "Secondary text, metadata" },
  { token: "--pale", value: "#f4f7f9", use: "Console background behind panels" },
  { token: "--line", value: "#d7e0e7", use: "Borders and dividers" }
] as const;

const TYPE_SCALE = [
  { name: "h1", note: "clamp(42px, 6vw, 70px) · only on the landing page" },
  { name: "h2", note: "32px · one per page, the page's own title" },
  { name: "h3", note: "Panel titles and list group headings" },
  { name: "lead", note: "19px · the sentence under a page title" },
  { name: "body", note: "16px · the default" },
  { name: "small", note: "13px · metadata, never the only carrier of meaning" }
] as const;

function Swatch({ token, value, use }: { token: string; value: string; use: string }) {
  return (
    <li className="swatch">
      <span className="swatch-chip" style={{ background: value }} aria-hidden="true" />
      <span>
        <code>{token}</code>
        <span className="muted small"> {value}</span>
        <span className="muted small swatch-use">{use}</span>
      </span>
    </li>
  );
}

export default async function StyleguidePage({
  params
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale: raw } = await params;
  if (!isLocale(raw)) notFound();
  const locale: Locale = raw;
  const messages = getMessages(locale);
  const sample = new Date("2026-09-19T08:00:00.000Z").toISOString();

  return (
    <div className="layout">
      <div className="shell stack">
        <PageHeader
          eyebrow="Design system"
          title="RESCUE"
          lead="Rendered from the product's own stylesheet and components, so it cannot drift from what ships."
          actions={
            <LinkButton href={`/${locale}`} variant="ghost">
              {messages.common.back}
            </LinkButton>
          }
        />

        <Panel title="Logo">
          <p className="muted">
            The lockup is the primary form. The mark stands alone only where the name is already
            present — the favicon, a van door, an avatar. Neither is ever redrawn, recoloured or
            set on a ground that swallows the navy.
          </p>
          <div className="stack" style={{ marginTop: 18 }}>
            <div className="logo-plate">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img className="logo-lockup" src="/brand/rescue-logo.png" alt="RESCUE lockup" />
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img className="logo-mark" src="/brand/rescue-mark.png" alt="RESCUE mark" />
            </div>
            <div className="logo-plate on-navy">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img className="logo-mark" src="/brand/rescue-mark.png" alt="RESCUE mark on navy" />
              <p className="small" style={{ color: "#fff", margin: 0, maxWidth: 420 }}>
                On navy the mark holds, because its own navy leg is carried by the green bowl
                either side of it. The full lockup does not — its wordmark is navy on navy — so on
                a dark ground use the mark and set the name in type.
              </p>
            </div>
          </div>
          <DefinitionList
            items={[
              {
                term: "Minimum height",
                value:
                  "40px for the lockup — below that its tagline stops being type — and 16px for the mark. The nav bar is 34px tall, so it carries the mark and sets the name in the interface face."
              },
              { term: "Clear space", value: "The height of the mark's arrow on every side" },
              { term: "Never", value: "Stretched, rotated, outlined, or with the arrow recoloured" }
            ]}
          />
        </Panel>

        <Panel title="Fleet">
          <p className="muted">
            Two liveries, both current. Photograph the whole vehicle: a crop through the flank cuts
            the lockup, and a cut lockup is not the lockup.
          </p>
          <div className="livery-pair" style={{ marginTop: 18 }}>
            <figure className="livery">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src="/brand/van-navy.jpg" alt={messages.landing.fleetNavyAlt} />
              <figcaption>{messages.landing.fleetNavy}</figcaption>
            </figure>
            <figure className="livery">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src="/brand/van-white.jpg" alt={messages.landing.fleetWhiteAlt} />
              <figcaption>{messages.landing.fleetWhite}</figcaption>
            </figure>
          </div>
        </Panel>

        <Panel title="Colour">
          <p className="muted">
            Navy, green and amber are sampled from the logo artwork rather than chosen beside it.
            Two greens, because the brand green carries only 3.6:1 against white: it fills the mark
            and decorative shapes, and --green-strong — the same hue, darkened to 4.7:1 — carries
            every button and every piece of green text. Amber means attention, not failure; red is
            reserved for errors and appears nowhere else.
          </p>
          <ul className="swatches">
            {COLOURS.map((colour) => (
              <Swatch key={colour.token} {...colour} />
            ))}
          </ul>
        </Panel>

        <Panel title="Type">
          <div className="stack">
            <h2 className="specimen">Gescheiterte Lieferung</h2>
            <h3 className="specimen">Angebot erstellen</h3>
            <p className="lead specimen">
              Geben Sie uns die betrieblichen Fakten. RESCUE schlägt Fahrzeug, Team und Route vor.
            </p>
            <p className="specimen">
              Fließtext in 16&nbsp;px. Zahlen laufen als Tabellenziffern, damit Beträge
              untereinander stehen: <span className="numeric">297,50 €</span>.
            </p>
            <p className="muted small specimen">Metadaten in 13 px, nie als einziger Träger einer Aussage.</p>
          </div>
          <DefinitionList
            items={TYPE_SCALE.map((entry) => ({ term: entry.name, value: entry.note }))}
          />
        </Panel>

        <Panel title="Buttons">
          <p className="muted">
            One primary action per panel. Ghost is for navigation away from the current task;
            secondary for the destructive or the lesser of two real choices.
          </p>
          <div className="actions">
            <button className="button" type="button">
              Angebot senden
            </button>
            <button className="button secondary" type="button">
              Auftrag stornieren
            </button>
            <button className="button ghost" type="button">
              {messages.common.back}
            </button>
            <button className="button" type="button" disabled>
              Wird übermittelt …
            </button>
          </div>
        </Panel>

        <Panel title="Status">
          <p className="muted">
            Every job status has a badge and a translated label. Tone carries a hint; the word
            carries the meaning, so the badges survive being read in greyscale.
          </p>
          <div className="actions">
            {jobStatuses.map((status: JobStatus) => (
              <StatusBadge key={status} status={status} messages={messages} />
            ))}
          </div>
          <div className="actions">
            <Tag tone="good">Geprüft</Tag>
            <Tag tone="bad">Abgelaufen</Tag>
            <Tag tone="neutral">In Prüfung</Tag>
            <Tag tone="muted">Inaktiv</Tag>
          </div>
        </Panel>

        <Panel title="Forms">
          <form className="form" onSubmit={undefined}>
            <div className="form-grid">
              <label htmlFor="sg-text">
                Straße und Hausnummer
                <input id="sg-text" name="sg-text" defaultValue="Am Markt 1" readOnly />
              </label>
              <label htmlFor="sg-select">
                Fahrzeugklasse
                <select id="sg-select" name="sg-select" defaultValue="LARGE_VAN">
                  <option value="SMALL_VAN">{messages.job.vehicle.SMALL_VAN}</option>
                  <option value="LARGE_VAN">{messages.job.vehicle.LARGE_VAN}</option>
                </select>
              </label>
            </div>
            <label htmlFor="sg-invalid">
              PLZ
              <input id="sg-invalid" defaultValue="281" aria-invalid="true" readOnly />
            </label>
            <p className="error">Bitte eine fünfstellige Postleitzahl angeben.</p>
            <label className="checkbox" htmlFor="sg-check">
              <input id="sg-check" type="checkbox" defaultChecked readOnly />
              Aufzug vorhanden
            </label>
            <fieldset>
              <legend>{messages.provider.serviceTypes}</legend>
              <label className="checkbox" htmlFor="sg-f1">
                <input id="sg-f1" type="checkbox" defaultChecked readOnly />
                {messages.job.type.FAILED_DELIVERY}
              </label>
              <label className="checkbox" htmlFor="sg-f2">
                <input id="sg-f2" type="checkbox" readOnly />
                {messages.job.type.BULKY_RETURN}
              </label>
            </fieldset>
          </form>
        </Panel>

        <Panel title="States">
          <p className="muted">
            Four of them, on every surface: empty, loading, error and success. A list with nothing
            in it says why, never just nothing.
          </p>
          <div className="stack">
            <EmptyState
              title={messages.customer.emptyTitle}
              body={messages.customer.emptyBody}
              action={<LinkButton href={`/${locale}/customer/new`}>{messages.customer.emptyCta}</LinkButton>}
            />
            <Skeleton rows={2} label={messages.common.loading} />
            <ErrorState
              title={messages.common.errorTitle}
              body={messages.errors.UNKNOWN}
              retry={<button className="button ghost" type="button">{messages.common.retry}</button>}
            />
            <SuccessNote>{messages.dispatch.quoteSent}</SuccessNote>
            <FormError code="VALIDATION_ERROR" messages={messages} />
            <p className="callout">
              <strong>{messages.provider.availabilityOff}</strong> {messages.provider.availabilityLead}
            </p>
          </div>
        </Panel>

        <Panel title="Data">
          <DefinitionList
            items={[
              { term: messages.job.pickup, value: "Am Markt 1, 28195 Bremen" },
              { term: messages.job.items, value: "1 × Sofa" },
              { term: messages.customer.quoteNet, value: <Money cents={25_000} locale={locale} /> },
              { term: messages.customer.quoteVat, value: <Money cents={4_750} locale={locale} /> },
              { term: messages.customer.quoteGross, value: <Money cents={29_750} locale={locale} /> },
              { term: messages.job.created, value: formatDate(sample, locale) }
            ]}
          />
          <ul className="job-list">
            <li>
              <span className="job-row">
                <span className="job-row-main">
                  <strong>E2E-4821</strong>
                  <span className="muted">28195 Bremen</span>
                </span>
                <StatusBadge status="QUOTED" messages={messages} />
              </span>
            </li>
            <li>
              <span className="job-row">
                <span className="job-row-main">
                  <strong>E2E-4822</strong>
                  <span className="muted">28309 Bremen</span>
                </span>
                <StatusBadge status="IN_PROGRESS" messages={messages} />
              </span>
            </li>
          </ul>
        </Panel>

        <Panel title="Rules this system keeps">
          <ul className="plain-list muted">
            <li>Every interactive element has a visible focus ring. Nothing removes the outline.</li>
            <li>Colour never carries meaning alone: a badge has a word, an invalid field has text.</li>
            <li>Amounts are integer cents and render through one component, so rounding is uniform.</li>
            <li>Motion respects <code>prefers-reduced-motion</code>; the loading shimmer stops.</li>
            <li>German is the source of truth. English is typed against it and cannot fall behind.</li>
            <li>The navigation wraps on a phone. It is never hidden — a provider works one-handed.</li>
            <li>The logo is a file, never a redrawing. Brand green fills; --green-strong carries text.</li>
          </ul>
        </Panel>
      </div>
    </div>
  );
}
