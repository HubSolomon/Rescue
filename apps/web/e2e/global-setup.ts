import { chromium } from "@playwright/test";

/**
 * Fail once, with the command, instead of twenty-six times with a stack trace.
 *
 * Playwright downloads its own browser rather than using the one on the
 * machine, so the first run on a fresh checkout fails for every test with the
 * same cause. Twenty-six copies of a launch error buries the one line that
 * matters, and the run before this existed took two people and a screenshot to
 * diagnose. Launching one browser here turns that into a single message.
 */
export default async function globalSetup(): Promise<void> {
  try {
    const browser = await chromium.launch({
      // Mirrors the projects' own launchOptions: an image that ships its own
      // Chromium points at it here too, or this check would fail on exactly
      // the machines the flag exists for.
      executablePath: process.env.PLAYWRIGHT_CHROME_PATH || undefined
    });
    await browser.close();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    if (!/Executable doesn't exist|please run the following command/i.test(detail)) throw error;

    throw new Error(
      [
        "",
        "The browser the end-to-end suite drives has not been downloaded.",
        "Playwright fetches its own rather than using the Chrome on this machine,",
        "so a fresh checkout needs this once:",
        "",
        "    pnpm e2e:install",
        "",
        "Then run pnpm test:e2e again. The original error follows.",
        "",
        detail
      ].join("\n")
    );
  }
}
