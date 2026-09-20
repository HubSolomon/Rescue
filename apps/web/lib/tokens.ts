import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The colour tokens, read from the stylesheet at build time.
 *
 * The styleguide used to carry its own copy of eight hex values. That is the
 * failure mode a styleguide exists to prevent: a page that says what the
 * product looked like on the day someone typed it out. It also showed eight of
 * the thirty-four tokens `:root` declares, so three quarters of the palette had
 * no page at all.
 *
 * Values now come from `globals.css` and cannot disagree with it. The prose
 * does not -- a usage note is editorial and belongs in a file a person edits --
 * but `tokens.test.ts` asserts every token in the stylesheet has one, so a new
 * token cannot arrive undocumented.
 *
 * Read at module scope, in a Server Component, so it happens once during
 * `next build` and never in a request.
 */

export interface ColourToken {
  /** With the leading `--`, as it is written in the stylesheet. */
  name: string;
  value: string;
  /** The `/* ... *​/` heading above it in `:root`. */
  group: string;
}

/**
 * The groups are the comments in `:root`.
 *
 * Grouping the palette by hand would be a second thing to keep in step. The
 * stylesheet already separates brand from ground from controls from tones with
 * a comment on each, so that structure is the one the page shows -- reorder
 * the stylesheet and the page follows.
 */
export function parseColourTokens(css: string): ColourToken[] {
  const root = /:root\s*\{([\s\S]*?)\n\}/.exec(css);
  if (!root) throw new Error("globals.css has no :root block");

  const tokens: ColourToken[] = [];
  let group = "Tokens";
  for (const line of root[1]!.split("\n")) {
    const heading = /\/\*\s*(.+?)\s*\*\//.exec(line);
    if (heading) {
      const text = heading[1]!;
      group = text.charAt(0).toUpperCase() + text.slice(1);
      continue;
    }
    for (const match of line.matchAll(/--([a-z0-9-]+)\s*:\s*([^;]+);/g)) {
      tokens.push({ name: `--${match[1]!}`, value: match[2]!.trim(), group });
    }
  }
  return tokens;
}

let cached: ColourToken[] | null = null;

export function colourTokens(): ColourToken[] {
  if (!cached) {
    cached = parseColourTokens(readFileSync(join(process.cwd(), "app/globals.css"), "utf8"));
  }
  return cached;
}
