import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseColourTokens } from "../lib/tokens";
import { TOKEN_NOTES } from "../lib/token-notes";

/**
 * The styleguide and the stylesheet cannot disagree.
 *
 * The page reads its values out of `globals.css`, so a drifting hex is no
 * longer possible. What is still possible is a token arriving with no
 * explanation, or a note outliving the token it described — both of which turn
 * a design system back into folklore. These are the two tests that stop that.
 */

const CSS = readFileSync(join(process.cwd(), "app/globals.css"), "utf8");
const TOKENS = parseColourTokens(CSS);

describe("the colour tokens", () => {
  it("finds every custom property :root declares", () => {
    // A floor rather than an exact count: the point is that the parser is
    // reading the real block, not that the palette never grows.
    expect(TOKENS.length).toBeGreaterThanOrEqual(34);
    expect(TOKENS.map((token) => token.name)).toContain("--green-strong");
    expect(TOKENS.find((token) => token.name === "--navy")?.value).toBe("#0d2b44");
  });

  it("gives every token a usage note", () => {
    const undocumented = TOKENS.filter((token) => !TOKEN_NOTES[token.name]).map((t) => t.name);
    expect(undocumented, `no note for: ${undocumented.join(", ")}`).toEqual([]);
  });

  it("keeps no note for a token that no longer exists", () => {
    const names = new Set(TOKENS.map((token) => token.name));
    const orphaned = Object.keys(TOKEN_NOTES).filter((name) => !names.has(name));
    expect(orphaned, `note without a token: ${orphaned.join(", ")}`).toEqual([]);
  });

  it("carries the stylesheet's own grouping comments", () => {
    const groups = [...new Set(TOKENS.map((token) => token.group))];
    // Four or more: brand, text and ground, controls, tones, situational.
    expect(groups.length).toBeGreaterThanOrEqual(4);
    expect(groups.some((group) => /brand/i.test(group))).toBe(true);
    // And no token falls outside a heading into the default bucket.
    expect(TOKENS.filter((token) => token.group === "Tokens")).toEqual([]);
  });

  it("writes a note that says what the token is for, not what it looks like", () => {
    for (const [name, note] of Object.entries(TOKEN_NOTES)) {
      expect(note.length, name).toBeGreaterThan(20);
      expect(note.trim().endsWith("."), `${name} note should be a sentence`).toBe(true);
    }
  });

  it("refuses a stylesheet with no :root block, rather than rendering nothing", () => {
    expect(() => parseColourTokens("body { color: red; }")).toThrow(/no :root block/);
  });
});
