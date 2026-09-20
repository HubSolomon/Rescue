#!/usr/bin/env node
/**
 * Captures the product as a walkthrough of one real job.
 *
 * Not mockups and not screenshots: the real markup, the real stylesheet and
 * the real components, rendered by the running app. A single request is driven
 * from a customer raising it, through a dispatcher assessing, pricing and
 * offering it, to a provider accepting, working and proving it -- and the page
 * is captured at each point, as the role who is looking at it.
 *
 * That ordering is the whole value. Eleven screens in a list show what the
 * product contains; one job moving through eleven screens shows what it does,
 * and makes the handovers between the three consoles visible -- which is the
 * part of this system that is actually difficult.
 *
 * The output is inert on purpose: no server sits behind it, so forms do not
 * submit and links do not navigate. The viewer says so, because a captured
 * page that looks interactive and is not wastes more of a reader's time than
 * one that is honest about it.
 *
 *   node scripts/capture-walkthrough.mjs     # expects the app on 3100/4100
 */

import { chromium } from "@playwright/test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const BASE = process.env.BASE ?? "http://127.0.0.1:3100";
const OUT = process.env.OUT ?? "/home/claude/walkthrough";
const WEB = "/home/claude/rescue/apps/web";
const REF = "RUNDGANG-1";

const ACCOUNTS = {
  customer: "Katrin Vogel",
  dispatcher: "Sven Kohl",
  provider: "Jörg Petersen"
};

const shots = [];

async function signIn(page, accountName) {
  await page.goto(`${BASE}/de/sign-in`, { waitUntil: "networkidle" });
  await page.locator("label.account", { hasText: accountName }).locator("input").check();
  await page.getByRole("button", { name: /Als dieses Konto anmelden/i }).click();
  await page.waitForURL((url) => !url.pathname.includes("/sign-in"));
}

async function signOut(page) {
  const button = page.getByRole("button", { name: /Abmelden/i });
  if (await button.count()) {
    await button.click();
    await page.waitForURL(/\/de\/?$/);
  }
}

/** Server actions revalidate; a panel that has not swapped yet is not a failure. */
async function settle(page, check) {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    await page.reload({ waitUntil: "networkidle" });
    if (await check()) return;
    await page.waitForTimeout(800);
  }
  throw new Error("the page never settled into the expected state");
}

async function openRow(page, text, urlPattern) {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    await page.getByRole("link").filter({ hasText: text }).first().click({ timeout: 3000 }).catch(() => {});
    if (urlPattern.test(page.url())) return;
    await page.waitForTimeout(500);
  }
  throw new Error(`could not open the row for ${text}`);
}

/** Strips the Next runtime: none of it can work without a server. */
function inertBody(html) {
  return /<body[^>]*>([\s\S]*)<\/body>/
    .exec(html)[1]
    .replace(/<script[\s\S]*?<\/script>/g, "")
    .replace(/<script[^>]*\/>/g, "")
    .replace(/<template[\s\S]*?<\/template>/g, "");
}

async function capture(page, step) {
  await page.waitForTimeout(250);
  shots.push({ ...step, url: new URL(page.url()).pathname, body: inertBody(await page.content()) });
  process.stdout.write(`  ${String(shots.length).padStart(2)}. ${step.title}\n`);
}

const browser = await chromium.launch({
  executablePath: process.env.PLAYWRIGHT_CHROME_PATH || undefined
});
const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: "de-DE" });
const page = await context.newPage();

/* ------------------------------------------------------------- 0. public */
process.stdout.write("public surfaces\n");
await page.goto(`${BASE}/de`, { waitUntil: "networkidle" });
await capture(page, {
  id: "landing", role: "Öffentlich", act: "Vor der Anmeldung", title: "Startseite",
  note: "The landing page sits on white; every console sits on pale. That one difference is how the two read as different places before anyone has read a word."
});

await page.goto(`${BASE}/de/sign-in`, { waitUntil: "networkidle" });
await capture(page, {
  id: "sign-in", role: "Öffentlich", act: "Vor der Anmeldung", title: "Anmeldung",
  note: "The development identity provider. It does not exist when an OIDC issuer is configured, and it cannot exist in production — the API refuses to boot without a real one."
});

/* ----------------------------------------------------- 1. customer asks */
process.stdout.write("the customer raises a request\n");
await signIn(page, ACCOUNTS.customer);
await page.goto(`${BASE}/de/customer/new`, { waitUntil: "networkidle" });
await capture(page, {
  id: "customer-new", role: "Kundin", act: "1 · Die Anfrage", title: "Neue Anfrage",
  note: "Every control has a real label; placeholders are examples, never labels. Errors appear against the field, in words, in German — never a bare 'invalid input'."
});

await page.getByLabel("Straße und Hausnummer").first().fill("Am Markt 1");
await page.getByLabel("PLZ").first().fill("28195");
await page.getByLabel("Stadt").first().fill("Bremen");
await page.getByLabel("Referenz", { exact: false }).fill(REF);
await page.getByLabel("Bezeichnung").fill("Sofa, dreisitzig");
await page.getByLabel("Gewicht kg", { exact: false }).fill("85");
await page.getByRole("button", { name: /Rückholung anfragen/i }).click();
await page.waitForURL(/\/de\/customer\/[0-9a-f-]{36}/);
const jobId = page.url().split("/").pop().split("?")[0];

await capture(page, {
  id: "customer-created", role: "Kundin", act: "1 · Die Anfrage", title: "Eingegangen",
  note: "The job exists and nothing has moved it. Triage has already produced a suggestion, recorded against the job with its prompt version — but no status changed, because no person has looked at it yet."
});

await page.goto(`${BASE}/de/customer`, { waitUntil: "networkidle" });
await capture(page, {
  id: "customer-list", role: "Kundin", act: "1 · Die Anfrage", title: "Meine Rückholungen",
  note: "Only this organisation's jobs. Another customer's id in the URL returns not-found rather than forbidden — a 403 would confirm the job exists."
});
await signOut(page);

/* -------------------------------------------- 2. dispatcher assesses it */
process.stdout.write("the dispatcher assesses, prices and offers\n");
await signIn(page, ACCOUNTS.dispatcher);
await page.goto(`${BASE}/de/dispatch`, { waitUntil: "networkidle" });
await capture(page, {
  id: "dispatch-list", role: "Disponent", act: "2 · Bewertung", title: "Disposition",
  note: "Staff read across every tenant. It is the one scope that does, by design, and the reason every transition carries an actor into an append-only log."
});

await openRow(page, REF, /\/de\/dispatch\/[0-9a-f-]{36}/);
const jobUrl = page.url();
await capture(page, {
  id: "dispatch-triage", role: "Disponent", act: "2 · Bewertung", title: "KI-Vorschlag, unverbindlich",
  note: "The suggestion sits beside the control, and the same sentence says it is advisory. requiresHumanApproval is typed as the literal true, so a model claiming otherwise produces an invalid suggestion that is discarded — not an overreaching one."
});

await page.getByRole("button", { name: /^Freigeben$/ }).click();
await page.getByText(/Angebot erstellen/i).waitFor();
await page.getByLabel(/Nettobetrag/i).fill("250,00");
await capture(page, {
  id: "dispatch-quote", role: "Disponent", act: "3 · Der Preis", title: "Angebot erstellen",
  note: "250,00 net. VAT and gross are computed in integer cents and checked by the database too: a quote whose gross is not net plus VAT is refused by a constraint, not only by the code."
});

await page.getByRole("button", { name: /Angebot senden/i }).click();
await settle(page, async () => (await page.getByText("Angebot vorliegt").first().count()) > 0);
await signOut(page);

/* ------------------------------------------------ 3. customer approves */
process.stdout.write("the customer approves the price\n");
await signIn(page, ACCOUNTS.customer);
await page.goto(`${BASE}/de/customer`, { waitUntil: "networkidle" });
await openRow(page, REF, /\/de\/customer\/[0-9a-f-]{36}/);
await capture(page, {
  id: "customer-quote", role: "Kundin", act: "3 · Der Preis", title: "297,50 € annehmen",
  note: "Money is written the German way and rendered through one component, so rounding is uniform everywhere. A job reaches ASSIGNED only from QUOTED with an approved quote — the state machine has no shortcut."
});

await page.getByRole("button", { name: /Angebot annehmen/i }).click();
await settle(page, async () => (await page.getByRole("button", { name: /Angebot annehmen/i }).count()) === 0);
await signOut(page);

/* ------------------------------------------------ 4. dispatcher offers */
await signIn(page, ACCOUNTS.dispatcher);
await page.goto(jobUrl, { waitUntil: "networkidle" });
await page.getByText(/Geeignete Partner/i).waitFor();
await page.getByLabel(/Vergütung netto/i).fill("180,00");
await capture(page, {
  id: "dispatch-eligibility", role: "Disponent", act: "4 · Die Vergabe", title: "Geeignete Partner",
  note: "Eligibility is a pure function over stored facts, and every exclusion carries its reason in words — expired document, outside the radius, not taking work today. A shortlist that cannot be explained is worse than a long one."
});

await page.getByRole("button", { name: /Angebote senden/i }).click();
await settle(page, async () => (await page.getByText(/180,00/).first().count()) > 0);
await signOut(page);

/* ------------------------------------------------- 5. provider accepts */
process.stdout.write("the provider accepts, works and proves it\n");
await signIn(page, ACCOUNTS.provider);
await capture(page, {
  id: "provider-offer", role: "Partner", act: "4 · Die Vergabe", title: "Angebot im Posteingang",
  note: "Used one-handed, outdoors, in a van. The navigation wraps onto a second line rather than collapsing into a menu, and nothing important is reachable only by hover."
});

await page.getByRole("button", { name: /^Annehmen$/ }).first().click();
await settle(page, async () => {
  await page.goto(`${BASE}/de/provider`, { waitUntil: "networkidle" });
  return (await page.getByText(REF).first().count()) > 0;
});
await openRow(page, REF, /\/de\/provider\/jobs\/[0-9a-f-]{36}/);
await capture(page, {
  id: "provider-job", role: "Partner", act: "5 · Die Arbeit", title: "Auftrag angenommen",
  note: "Two providers accepting the same offer is resolved in the database, not the application: one wins, one gets a conflict. The payout carried here is what this provider accepted, never a share recomputed later."
});

await page.getByRole("button", { name: /Abholung starten/i }).click();
await settle(page, async () => (await page.getByRole("button", { name: /Auftrag abschließen/i }).count()) > 0);

await page.setInputFiles('input[type="file"]', {
  name: "nachweis.png",
  mimeType: "image/png",
  buffer: Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64"
  )
});
await page.getByRole("button", { name: /^Hochladen$/ }).click();
const complete = page.getByRole("button", { name: /Auftrag abschließen/i });
await settle(page, async () => complete.isEnabled().catch(() => false));
await capture(page, {
  id: "provider-evidence", role: "Partner", act: "5 · Die Arbeit", title: "Nachweis hochgeladen",
  note: "Completion is refused until proof exists, so the button enabling is the confirmation the upload landed. Evidence is the largest concentration of personal data here and the only category deleted on a timer — one year."
});

await complete.click();
await settle(page, async () => (await page.getByText("Abgeschlossen").first().count()) > 0);

await page.goto(`${BASE}/de/provider/fleet`, { waitUntil: "networkidle" });
await capture(page, {
  id: "provider-fleet", role: "Partner", act: "Nebenbei", title: "Fuhrpark und Nachweise",
  note: "A German registration identifies a keeper, so it is personal data about a driver. It is stored as a keyed hash and never in plaintext — and the log redaction strips it too."
});

await page.goto(`${BASE}/de/provider`, { waitUntil: "networkidle" });
await capture(page, {
  id: "provider-availability", role: "Partner", act: "Nebenbei", title: "Verfügbarkeit",
  note: "A paused provider's inbox is empty, and the banner says why. An empty inbox has two very different causes and the interface must not leave the provider guessing which."
});
await signOut(page);

/* ------------------------------------------------ 6. the customer sees */
process.stdout.write("the customer sees it finished\n");
await signIn(page, ACCOUNTS.customer);
await page.goto(`${BASE}/de/customer`, { waitUntil: "networkidle" });
await openRow(page, REF, /\/de\/customer\/[0-9a-f-]{36}/);
await capture(page, {
  id: "customer-done", role: "Kundin", act: "6 · Abgeschlossen", title: "Abgeschlossen",
  note: "The same job, closed, with the whole history beneath it. Every line names who did it — and for the sweep or the worker, a system actor rather than a blank, because a blank reads as a missing record."
});
await signOut(page);

await page.goto(`${BASE}/de/styleguide`, { waitUntil: "networkidle" });
await capture(page, {
  id: "styleguide", role: "Öffentlich", act: "Nebenbei", title: "Design System",
  note: "All 34 colour tokens, read out of globals.css when the page is built. There is no second copy to fall out of step with the stylesheet, and a token added without a usage note fails a test."
});

await browser.close();

mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, "shots.json"), JSON.stringify({ jobId, shots }, null, 2));
writeFileSync(join(OUT, "globals.css"), readFileSync(join(WEB, "app/globals.css"), "utf8"));
process.stdout.write(`\n${shots.length} surfaces captured into ${OUT}\n`);
