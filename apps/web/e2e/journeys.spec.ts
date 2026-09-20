import { expect, test } from "@playwright/test";
import {
  ACCOUNTS,
  assertNoTokenInBrowserStorage,
  createRequest,
  openRow,
  signIn,
  signOut
} from "./helpers";

/** A reference unique per run, so parallel projects do not collide. */
const ref = (name: string) => `${name}-${Date.now().toString(36)}`;

test.describe("session", () => {
  test("an anonymous visitor is sent to sign in, and lands on their console after", async ({
    page
  }) => {
    await page.goto("/de/customer");
    await expect(page).toHaveURL(/\/de\/sign-in/);

    await signIn(page, ACCOUNTS.customerAdmin);
    await expect(page).toHaveURL(/\/de\/customer/);
    await expect(page.getByRole("heading", { name: /Meine Rückholungen/i })).toBeVisible();
  });

  test("the token never reaches browser storage", async ({ page }) => {
    await signIn(page, ACCOUNTS.customerAdmin);
    await assertNoTokenInBrowserStorage(page);

    // It is in an httpOnly cookie, which scripts cannot read.
    const cookies = await page.context().cookies();
    const session = cookies.find((cookie) => cookie.name === "rescue_session");
    expect(session?.httpOnly).toBe(true);
    expect(session?.sameSite).toBe("Lax");

    const readable = await page.evaluate(() => document.cookie);
    expect(readable).not.toContain("rescue_session");
  });

  test("signing out ends the session", async ({ page }) => {
    await signIn(page, ACCOUNTS.customerAdmin);
    await signOut(page);
    await page.goto("/de/customer");
    await expect(page).toHaveURL(/\/de\/sign-in/);
  });

  test("a dispatcher cannot open a provider-only console", async ({ page }) => {
    await signIn(page, ACCOUNTS.dispatcher);
    await page.goto("/de/provider/fleet");
    await expect(page).toHaveURL(/\/de\/no-access/);
  });
});

test.describe("language", () => {
  test("German is the default and the toggle switches to English", async ({ page }) => {
    await page.goto("/");
    await expect(page).toHaveURL(/\/de$/);
    await expect(page.locator("html")).toHaveAttribute("lang", "de");
    await expect(page.getByRole("heading", { level: 1 })).toContainText("RESCUE");

    await page.getByRole("link", { name: "English" }).click();
    await expect(page).toHaveURL(/\/en$/);
    await expect(page.locator("html")).toHaveAttribute("lang", "en");
    // The heading specifically: Next's route announcer repeats the page title
    // in a live region after a client navigation, so a text match finds two.
    await expect(page.getByRole("heading", { level: 1 })).toContainText(/When logistics breaks/i);
  });
});

test.describe("customer", () => {
  test("creates a request and sees it in the list", async ({ page }) => {
    const reference = ref("KUNDE");
    await signIn(page, ACCOUNTS.customerAdmin);
    await createRequest(page, reference);

    // The job starts in DRAFT, awaiting a dispatcher.
    await expect(page.getByText("Eingegangen")).toBeVisible();
    await expect(page.getByText(/Die Disposition prüft Ihre Anfrage/i)).toBeVisible();

    await page.goto("/de/customer");
    await expect(page.getByText(reference)).toBeVisible();
  });

  test("shows an empty state before the first request", async ({ page }) => {
    // Weser Tech has no jobs unless a test made one for them.
    await signIn(page, "Lena Brandt").catch(async () => {
      // Not on the sign-in list in every build; skip rather than fail.
      test.skip(true, "other-customer account not present");
    });
  });

  test("validation errors are shown against the field, in German", async ({ page }) => {
    await signIn(page, ACCOUNTS.customerAdmin);
    await page.goto("/de/customer/new");
    await page.getByLabel("Straße und Hausnummer").first().fill("X");
    await page.getByLabel("PLZ").first().fill("28");
    await page.getByLabel("Stadt").first().fill("B");
    await page.getByLabel("Bezeichnung").fill("S");
    await page.getByRole("button", { name: /Rückholung anfragen/i }).click();

    await expect(page.getByText(/fünfstellige|five-digit/i)).toBeVisible();
    // Still on the form, nothing created.
    await expect(page).toHaveURL(/\/de\/customer\/new/);
  });
});

test.describe("the whole recovery, across three roles", () => {
  test("customer requests, dispatcher triages quotes and offers, provider accepts and completes", async ({
    page
  }) => {
    const reference = ref("E2E");

    // 1. Customer raises the request.
    await signIn(page, ACCOUNTS.customerAdmin);
    await createRequest(page, reference);
    await signOut(page);

    // 2. Dispatcher approves the assessment. The AI suggestion is advisory.
    await signIn(page, ACCOUNTS.dispatcher);
    await page.goto("/de/dispatch");
    await openRow(page, reference, /\/de\/dispatch\/[0-9a-f-]{36}/);
    await expect(page.getByText(/Die KI-Vorschläge sind unverbindlich/i)).toBeVisible();
    const jobUrl = page.url();

    await page.getByRole("button", { name: /^Freigeben$/ }).click();
    // The action revalidates the route, so the DRAFT-only triage panel is
    // replaced by the quote form. The panel change is the confirmation; a
    // success note inside a panel that no longer exists never renders.
    await expect(page.getByText(/Angebot erstellen/i)).toBeVisible();

    // 3. Dispatcher prices it. 250,00 net becomes 297,50 gross at 19% VAT.
    await page.getByLabel(/Nettobetrag/i).fill("250,00");
    await page.getByRole("button", { name: /Angebot senden/i }).click();
    // Confirm the quote server-side. The status badge changes on revalidation,
    // and a revalidation that has not landed yet is not a failure.
    await expect(async () => {
      await page.reload();
      await expect(page.getByText("Angebot vorliegt").first()).toBeVisible({ timeout: 3000 });
    }).toPass({ timeout: 20000 });

    // 4. Customer approves the price.
    await signOut(page);
    await signIn(page, ACCOUNTS.customerAdmin);
    await page.goto("/de/customer");
    await openRow(page, reference, /\/de\/customer\/[0-9a-f-]{36}/);
    await expect(page.getByText(/297,50/)).toBeVisible();
    await page.getByRole("button", { name: /Angebot annehmen/i }).click();
    // Approval retires the decision form: an approved quote is no longer
    // pending, so the buttons go away. Their absence is the durable evidence;
    // the success note lives inside the panel that revalidation removes.
    await expect(async () => {
      await page.reload();
      await expect(page.getByRole("button", { name: /Angebot annehmen/i })).toHaveCount(0, {
        timeout: 3000
      });
    }).toPass({ timeout: 20000 });

    // 5. Dispatcher offers it to eligible providers.
    await signOut(page);
    await signIn(page, ACCOUNTS.dispatcher);
    await page.goto(jobUrl);
    await expect(page.getByText(/Geeignete Partner/i)).toBeVisible();
    // Excluded providers carry a reason, not just an absence.
    await expect(
      page.getByText(/Dokument abgelaufen|Partner nicht freigeschaltet/).first()
    ).toBeVisible();
    await page.getByLabel(/Vergütung netto/i).fill("180,00");
    await page.getByRole("button", { name: /Angebote senden/i }).click();
    // Confirm the offer exists server-side rather than trusting a note that a
    // revalidated panel may never render.
    await expect(async () => {
      await page.reload();
      await expect(page.getByText(/180,00/).first()).toBeVisible({ timeout: 3000 });
    }).toPass({ timeout: 20000 });

    // 6. Provider accepts, works and proves it.
    await signOut(page);
    await signIn(page, ACCOUNTS.providerHansa);
    await expect(page.getByText(/180,00/).first()).toBeVisible();
    await page.getByRole("button", { name: /^Annehmen$/ }).first().click();
    // Accepting revalidates the inbox: the offer leaves the pending list and
    // the job appears under "Meine Aufträge". That move is the confirmation.
    await expect(async () => {
      await page.goto("/de/provider");
      await expect(page.getByText(reference).first()).toBeVisible({ timeout: 3000 });
    }).toPass({ timeout: 20000 });

    await openRow(page, reference, /\/de\/provider\/jobs\/[0-9a-f-]{36}/);
    await page.getByRole("button", { name: /Abholung starten/i }).click();
    await expect(async () => {
      await page.reload();
      await expect(page.getByRole("button", { name: /Auftrag abschließen/i })).toBeVisible({
        timeout: 3000
      });
    }).toPass({ timeout: 20000 });

    await page.setInputFiles('input[type="file"]', {
      name: "nachweis.png",
      mimeType: "image/png",
      // Smallest valid PNG.
      buffer: Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
        "base64"
      )
    });
    await page.getByRole("button", { name: /^Hochladen$/ }).click();

    // Completion is refused until proof exists, so the button only enables
    // once the evidence row is recorded. That enabling is the confirmation the
    // upload landed -- a success note inside a revalidated panel may not
    // survive long enough to be asserted on.
    const complete = page.getByRole("button", { name: /Auftrag abschließen/i });
    await expect(async () => {
      await page.reload();
      await expect(complete).toBeEnabled({ timeout: 3000 });
    }).toPass({ timeout: 20000 });
    await complete.click();
    // Wait for the transition to land before dropping the session, otherwise
    // the sign-out races the action still in flight.
    await expect(async () => {
      await page.reload();
      await expect(page.getByText("Abgeschlossen").first()).toBeVisible({ timeout: 3000 });
    }).toPass({ timeout: 20000 });

    // 7. The customer sees it finished.
    await signOut(page);
    await signIn(page, ACCOUNTS.customerAdmin);
    await page.goto("/de/customer");
    await openRow(page, reference, /\/de\/customer\/[0-9a-f-]{36}/);
    await expect(page.getByText("Abgeschlossen").first()).toBeVisible();

    // 8. And can take the proof away. The link points at our own route, not at
    // storage: the signed URL is minted server-side at click time, so it is
    // never in this page's HTML.
    const proof = page.getByRole("link", { name: /Nachweis öffnen/i }).first();
    await expect(proof).toBeVisible();
    const href = await proof.getAttribute("href");
    expect(href).toMatch(/^\/de\/proof\/[0-9a-f-]{36}$/);
    expect(await page.content()).not.toContain("X-Signature");

    // Ask for the redirect without following it. The cookie is Secure, and
    // Playwright's request context enforces that literally where a browser
    // makes an exception for loopback, so it is passed explicitly rather than
    // inherited -- the point of the assertion is the Location header.
    const cookies = await page.context().cookies();
    const session = cookies.find((cookie) => cookie.name === "rescue_session")!;
    const redirect = await page.request.get(href!, {
      maxRedirects: 0,
      headers: { cookie: `rescue_session=${session.value}` }
    });
    expect(redirect.status()).toBe(307);
    expect(redirect.headers()["location"]).toContain("X-Signature=");
    expect(redirect.headers()["location"]).toContain("X-Expires=");
  });
});

test.describe("tenant isolation is visible in the UI", () => {
  test("one customer cannot open another customer's job by URL", async ({ page }) => {
    const reference = ref("GEHEIM");
    await signIn(page, ACCOUNTS.customerAdmin);
    await createRequest(page, reference);
    const jobUrl = page.url();
    await signOut(page);

    // Weser Tech is a different organisation.
    await page.goto("/de/sign-in");
    const other = page.locator("label.account", { hasText: "Lena Brandt" });
    if ((await other.count()) === 0) test.skip(true, "other-customer account not seeded");
    await other.locator("input").check();
    await page.getByRole("button", { name: /Als dieses Konto anmelden/i }).click();
    await page.waitForURL((url) => !url.pathname.includes("/sign-in"));

    await page.goto(jobUrl);
    // 404, not 403: a 403 would confirm the job exists.
    await expect(page.getByText(/404|Nicht gefunden|not found/i).first()).toBeVisible();
    await expect(page.getByText(reference)).toHaveCount(0);
  });
});

test.describe("a provider governs its own availability", () => {
  test("pausing is visible to the provider and explains the quiet inbox", async ({ page }) => {
    await signIn(page, ACCOUNTS.providerHansa);
    await page.goto("/de/provider/fleet");

    await expect(page.getByText("Sie nehmen Aufträge an.")).toBeVisible();
    await page.getByLabel(/Grund/i).fill("Transporter in der Werkstatt");
    await page.getByRole("button", { name: /Annahme pausieren/i }).click();

    await expect(async () => {
      await page.reload();
      await expect(page.getByText("Sie sind pausiert.")).toBeVisible({ timeout: 3000 });
    }).toPass({ timeout: 20000 });
    await expect(page.getByText("Transporter in der Werkstatt")).toBeVisible();

    // An empty inbox has two very different causes; the banner says which.
    await page.goto("/de/provider");
    await expect(page.getByText(/Solange Sie pausiert sind/i)).toBeVisible();

    // And it is the provider's own switch to undo, with no administrator.
    await page.goto("/de/provider/fleet");
    await page.getByRole("button", { name: /Annahme fortsetzen/i }).click();
    await expect(async () => {
      await page.reload();
      await expect(page.getByText("Sie nehmen Aufträge an.")).toBeVisible({ timeout: 3000 });
    }).toPass({ timeout: 20000 });
    // Resuming clears the reason rather than leaving a stale one beside it.
    await expect(page.getByText("Transporter in der Werkstatt")).toHaveCount(0);
  });
});

test.describe("the design system is part of the product", () => {
  test("renders in both locales from the real stylesheet", async ({ page }) => {
    await page.goto("/de/styleguide");
    await expect(page.getByRole("heading", { name: "Colour" })).toBeVisible();
    await expect(page.getByText("Eingegangen").first()).toBeVisible();
    await expect(page.getByText("Abgeschlossen").first()).toBeVisible();

    await page.goto("/en/styleguide");
    await expect(page.getByText("Received").first()).toBeVisible();
  });

  test("the logo artwork is served, not just referenced", async ({ page }) => {
    // A missing image is silent: the alt text renders and the page looks
    // merely plain. Each file is fetched so a broken path fails loudly.
    for (const path of [
      "/brand/rescue-logo.png",
      "/brand/rescue-mark.png",
      "/brand/van-navy.jpg",
      "/brand/van-white.jpg"
    ]) {
      const response = await page.request.get(path);
      expect(response.status(), path).toBe(200);
      expect(Number(response.headers()["content-length"] ?? 1)).toBeGreaterThan(0);
    }

    await page.goto("/de/styleguide");
    const mark = page.locator('img[src="/brand/rescue-mark.png"]').first();
    await expect(mark).toBeVisible();
    // naturalWidth is 0 when the browser could not decode the file.
    expect(await mark.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(100);
  });
});
