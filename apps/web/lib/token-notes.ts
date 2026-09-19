/**
 * Why each colour token exists.
 *
 * The values live in `globals.css` and are read from it; this is the half a
 * machine cannot derive. Every token in `:root` must appear here —
 * `tokens.test.ts` fails otherwise — so the palette cannot grow a member
 * nobody can explain.
 *
 * A note says what the token is *for*, not what it looks like. "A light grey"
 * helps nobody choose between three light greys.
 */
export const TOKEN_NOTES: Record<string, string> = {
  /* brand */
  "--navy": "Headings, labels, the secondary button. Sampled from the wordmark.",
  "--green": "The mark's bowl. Fills and decoration only — 3.6:1, so never text and never behind it.",
  "--green-strong": "The same green darkened to 4.7:1. Every button, and every piece of green text.",
  "--amber": "The mark's arrow. Attention that is not yet failure. Never text, never an error.",

  /* text and ground */
  "--ink": "Body text, on white and on pale.",
  "--muted": "Secondary text and metadata. Never the only carrier of a meaning.",
  "--pale": "The console ground behind panels. The landing page uses white, which is how the two read as different places.",
  "--line": "Borders, dividers, and the hairline under the sticky nav.",
  "--surface": "Panels, cards, rows and controls: anything above the pale ground.",

  /* controls */
  "--input-border": "Resting border on a field. Darker than --line so it reads as interactive before focus.",
  "--focus": "The focus ring: 3px at 2px offset, on everything. Nothing removes the outline.",
  "--error": "Field error text, and the border of an input carrying aria-invalid. Reserved.",

  /* badge tones */
  "--tone-neutral-bg": "Badge ground for a state with no valence, such as a document awaiting review.",
  "--tone-neutral-ink": "On --tone-neutral-bg. 7.2:1.",
  "--tone-info-bg": "Badge ground for a job that has moved but needs nothing yet: Assessed, Quoted.",
  "--tone-info-ink": "On --tone-info-bg. 8.1:1.",
  "--tone-progress-bg": "Badge ground for work under way: Provider assigned, In progress.",
  "--tone-progress-ink": "On --tone-progress-bg. 6.4:1.",
  "--tone-good-bg": "Badge and success-note ground for a finished or verified thing.",
  "--tone-good-ink": "On --tone-good-bg. 5.3:1.",
  "--tone-bad-bg": "Badge ground for an expired or rejected document. Not for form errors, which are plain text.",
  "--tone-bad-ink": "On --tone-bad-bg. 7.4:1.",
  "--tone-muted-bg": "Badge ground for something switched off or cancelled: present, not active.",
  "--tone-muted-ink": "On --tone-muted-bg. 5.9:1.",

  /* situational surfaces */
  "--callout-bg": "The banner explaining a condition the person can change — a paused provider's empty inbox.",
  "--callout-line": "Callout border, thickened to 4px on the leading edge.",
  "--callout-ink": "Callout text. 5.1:1, the lowest ratio in the system.",
  "--error-surface": "Ground of the error state panel.",
  "--error-line": "Border of the error state panel.",
  "--error-ink": "Text in the error state panel. 9.8:1 — far past AA, because it is read by someone who is already not reading carefully.",
  "--eligible-surface": "The faint wash on eligible rows in the dispatcher's provider list, and on the selected account at sign-in.",
  "--paused-ink": "The availability line while a provider is paused. The word says it; the colour only agrees.",
  "--skeleton-base": "Loading placeholder ground.",
  "--skeleton-sheen": "The moving band in the shimmer. It stops under prefers-reduced-motion."
};
