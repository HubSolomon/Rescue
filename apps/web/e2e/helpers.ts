import { expect, type Page } from "@playwright/test";

/** The seeded development accounts, by the name shown on the sign-in page. */
export const ACCOUNTS = {
  customerAdmin: "Katrin Vogel",
  customerMember: "Tobias Reimer",
  dispatcher: "Sven Kohl",
  compliance: "Miriam Falk",
  providerHansa: "Jörg Petersen",
  providerRoland: "Annika Schuster",
  admin: "Platform Admin"
} as const;

export async function signIn(page: Page, accountName: string): Promise<void> {
  await page.goto("/de/sign-in");
  await page.getByRole("radio").filter({ hasNotText: "" }).first().waitFor();
  // Each account is a radio wrapped in a label showing the person's name.
  await page.locator("label.account", { hasText: accountName }).locator("input").check();
  await page.getByRole("button", { name: /Als dieses Konto anmelden/i }).click();
  await page.waitForURL((url) => !url.pathname.includes("/sign-in"));
}

export async function signOut(page: Page): Promise<void> {
  await page.getByRole("button", { name: /Abmelden/i }).click();
  await page.waitForURL(/\/de\/?$/);
}

/** Creates a request as the signed-in customer and returns its reference. */
export async function createRequest(page: Page, reference: string): Promise<void> {
  await page.goto("/de/customer/new");
  await page.getByLabel("Straße und Hausnummer").first().fill("Am Markt 1");
  await page.getByLabel("PLZ").first().fill("28195");
  await page.getByLabel("Stadt").first().fill("Bremen");
  await page.getByLabel("Referenz", { exact: false }).fill(reference);
  await page.getByLabel("Bezeichnung").fill("Sofa");
  await page.getByLabel("Gewicht kg", { exact: false }).fill("85");
  await page.getByRole("button", { name: /Rückholung anfragen/i }).click();
  await page.waitForURL(/\/de\/customer\/[0-9a-f-]{36}/);
  await expect(page.getByRole("heading", { level: 2 })).toContainText(reference);
}

/**
 * Clicks a row and waits for the detail route to actually open.
 *
 * A click that lands in the window between the HTML arriving and React
 * hydrating is swallowed: the anchor's default is prevented but the router is
 * not yet listening, so nothing navigates. A real person clicks again; the
 * test does the same rather than pretending the first click always takes.
 */
export async function openRow(page: Page, text: string, expectedUrl: RegExp): Promise<void> {
  await expect(async () => {
    await page.getByText(text).first().click();
    await page.waitForURL(expectedUrl, { timeout: 3000 });
  }).toPass({ timeout: 20_000 });
}

/** Nothing sensitive may be readable from the browser. */
export async function assertNoTokenInBrowserStorage(page: Page): Promise<void> {
  const storage = await page.evaluate(() => ({
    local: JSON.stringify(window.localStorage),
    session: JSON.stringify(window.sessionStorage)
  }));
  expect(storage.local).not.toMatch(/eyJ/);
  expect(storage.session).not.toMatch(/eyJ/);
  expect(storage.local.length).toBeLessThan(200);
}
