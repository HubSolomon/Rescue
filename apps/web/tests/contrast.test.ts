import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Contrast, checked against the stylesheet rather than asserted in prose.
 *
 * The design system claims that colour never carries meaning alone and that
 * every text pair clears WCAG AA. A claim like that decays the first time
 * someone nudges a hex value, so the pairs are read out of `globals.css` here
 * and the ratios are computed. If a token moves and a pair drops below its
 * threshold, this fails rather than the claim quietly becoming false.
 *
 * It also pins the specific mistake that made `--green-strong` necessary: the
 * brand green is the mark's own value and does not carry white text, so it
 * must never end up on a button.
 */

// Resolved from the package root rather than from import.meta.url: the test
// runs in a jsdom environment, where that URL is not a file: URL.
const CSS = readFileSync(join(process.cwd(), "app/globals.css"), "utf8");

/** Reads a custom property off the `:root` block. */
function token(name: string): string {
  const match = CSS.match(new RegExp(`--${name}\\s*:\\s*(#[0-9a-fA-F]{6})`));
  if (!match) throw new Error(`--${name} is not declared in globals.css`);
  return match[1]!.toLowerCase();
}

function relativeLuminance(hex: string): number {
  const channels = [1, 3, 5].map((index) => parseInt(hex.slice(index, index + 2), 16) / 255);
  const linear = channels.map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * linear[0]! + 0.7152 * linear[1]! + 0.0722 * linear[2]!;
}

export function contrast(a: string, b: string): number {
  const [light, dark] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x);
  return (light! + 0.05) / (dark! + 0.05);
}

const WHITE = "#ffffff";

describe("the brand colours are the ones in the logo artwork", () => {
  // Sampled from apps/web/public/brand/rescue-logo.png. If the artwork is
  // replaced these change together; a drift in one alone is a mistake.
  it.each([
    ["navy", "#0d2b44"],
    ["green", "#0d9b67"],
    ["amber", "#f6a641"]
  ])("--%s is %s", (name, value) => {
    expect(token(name)).toBe(value);
  });
});

describe("text clears WCAG AA against the ground it sits on", () => {
  const pale = token("pale");

  it.each([
    ["ink on white", token("ink"), WHITE],
    ["ink on pale", token("ink"), pale],
    ["muted on white", token("muted"), WHITE],
    ["muted on pale", token("muted"), pale],
    ["navy on white", token("navy"), WHITE],
    ["navy on pale", token("navy"), pale],
    ["white on the primary button", WHITE, token("green-strong")],
    ["white on the secondary button", WHITE, token("navy")],
    ["green text on white", token("green-strong"), WHITE],
    ["error text on white", token("error"), WHITE]
  ])("%s", (_label, foreground, background) => {
    expect(contrast(foreground, background)).toBeGreaterThanOrEqual(4.5);
  });
});

describe("every badge tone pairs a ground with text that reads on it", () => {
  it.each(["neutral", "info", "progress", "good", "bad", "muted"])("tone-%s", (tone) => {
    expect(contrast(token(`tone-${tone}-ink`), token(`tone-${tone}-bg`))).toBeGreaterThanOrEqual(
      4.5
    );
  });

  it("the callout reads on its own ground", () => {
    expect(contrast(token("callout-ink"), token("callout-bg"))).toBeGreaterThanOrEqual(4.5);
  });

  it("the paused line reads on white", () => {
    expect(contrast(token("paused-ink"), WHITE)).toBeGreaterThanOrEqual(4.5);
  });
});

describe("the brand green is kept away from text", () => {
  it("does not itself carry white text", () => {
    // Stated as a fact, not an aspiration: this is why --green-strong exists.
    expect(contrast(WHITE, token("green"))).toBeLessThan(4.5);
  });

  it("is never the background of a button", () => {
    const button = CSS.match(/\.button \{[^}]*\}/)?.[0] ?? "";
    expect(button).toContain("background:var(--green-strong)");
    expect(button).not.toContain("background:var(--green)");
  });

  it("is never the colour of the eyebrow", () => {
    const eyebrow = CSS.match(/\.eyebrow \{[^}]*\}/)?.[0] ?? "";
    expect(eyebrow).toContain("color:var(--green-strong)");
  });

  it("still clears 3:1 as a non-text boundary, which is what it is used for", () => {
    // The hover border on a list row and the focus-adjacent dots.
    expect(contrast(token("green"), WHITE)).toBeGreaterThanOrEqual(3);
  });
});

describe("the focus ring is visible on every ground it lands on", () => {
  it.each([
    ["white", WHITE],
    ["pale", token("pale")],
    ["surface", token("surface")]
  ])("on %s", (_label, ground) => {
    expect(contrast(token("focus"), ground)).toBeGreaterThanOrEqual(3);
  });
});
