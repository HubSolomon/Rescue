import { defineConfig, devices } from "@playwright/test";

const WEB_PORT = Number(process.env.E2E_WEB_PORT ?? 3100);
const API_PORT = Number(process.env.E2E_API_PORT ?? 4100);
const API_URL = `http://127.0.0.1:${API_PORT}`;

/**
 * Some CI images ship a Chromium that does not match the Playwright version's
 * expected build number. PLAYWRIGHT_CHROME_PATH points at the one that is
 * actually installed; unset, Playwright resolves its own download as usual.
 */
const CHROME_PATH = process.env.PLAYWRIGHT_CHROME_PATH || undefined;

/**
 * End-to-end tests run the real API and the real web app together, against
 * the in-memory store and the development identity provider. No mocking: the
 * point is to prove the two halves agree, including the session cookie and
 * the tenant rules.
 */
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"]] : [["list"]],
  timeout: 45_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL: `http://127.0.0.1:${WEB_PORT}`,
    trace: "retain-on-failure",
    locale: "de-DE"
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"], launchOptions: { executablePath: CHROME_PATH } }
    },
    // The provider surface is used on a phone, in a van, one-handed.
    {
      name: "mobile",
      use: { ...devices["Pixel 7"], launchOptions: { executablePath: CHROME_PATH } }
    }
  ],
  webServer: [
    {
      command: "pnpm --filter @rescue/api exec tsx src/server.ts",
      cwd: "../..",
      port: API_PORT,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
      env: {
        NODE_ENV: "development",
        API_PORT: String(API_PORT),
        API_HOST: "127.0.0.1",
        WEB_ORIGIN: `http://127.0.0.1:${WEB_PORT}`,
        JWT_SECRET: "end-to-end-test-secret-long-enough-for-validation",
        REGISTRATION_HASH_KEY: "end-to-end-test-registration-key-long-enough",
        // A full journey drives far more than a human would in a minute.
        RATE_LIMIT_MAX: "100000"
      }
    },
    {
      command: `pnpm exec next start --port ${WEB_PORT}`,
      port: WEB_PORT,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      env: { API_URL, NEXT_PUBLIC_API_URL: API_URL }
    }
  ]
});
