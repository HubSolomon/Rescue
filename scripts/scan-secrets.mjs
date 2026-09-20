#!/usr/bin/env node
/**
 * A secret scanner with no dependencies.
 *
 * Not a replacement for a real one -- it has no entropy analysis and no
 * knowledge of provider-specific formats beyond what is written below. It
 * exists because the alternative on offer was a third-party action with
 * repository read access running on every push, and for a repository this size
 * that is a larger supply-chain exposure than the risk it mitigates.
 *
 * What it is good at is the failure that actually happens: somebody pastes a
 * working value into a `.env.example`, a test fixture or a README while
 * getting something to run, and it is still there a year later. Every pattern
 * here is one that has leaked from a real repository.
 *
 * Exit 1 on a finding. `pnpm scan:secrets`.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const ROOT = process.cwd();

const SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  ".next",
  "dist",
  "build",
  "coverage",
  ".turbo",
  "test-results",
  "playwright-report",
  ".pnpm-store"
]);

/** Binary and generated files, where a match would be noise. */
const SKIP_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".svg",
  ".ico",
  ".woff",
  ".woff2",
  ".ttf",
  ".pdf",
  ".zip",
  ".bundle",
  ".lock",
  ".map"
]);

const RULES = [
  {
    name: "AWS access key id",
    pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/,
    note: "An AWS key id. Rotate it before anything else."
  },
  {
    name: "private key block",
    pattern: /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/,
    note: "A private key in the repository."
  },
  {
    name: "GitHub token",
    pattern: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/,
    note: "A GitHub personal access or app token."
  },
  {
    name: "Slack token",
    pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/,
    note: "A Slack token."
  },
  {
    name: "Stripe secret key",
    pattern: /\b[sr]k_(?:live|test)_[A-Za-z0-9]{20,}\b/,
    note: "A Stripe key. Even a test key is worth rotating."
  },
  {
    name: "JSON Web Token",
    // Three base64url segments. Catches a token pasted into a fixture.
    pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/,
    note: "A signed JWT. If it is a real one, its signing key is compromised too."
  },
  {
    name: "database URL with a password",
    /**
     * `postgresql://user:password@host`. The exclusions matter more than the
     * pattern: this repository's own examples use `postgres`, `postgres` and
     * `password`, which are placeholders, and a scanner that shouts about them
     * is a scanner people learn to ignore.
     */
    pattern: /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis):\/\/[^\s:/@]+:([^\s:/@]+)@/,
    note: "A connection string with a password in it.",
    allow: (match) => {
      const value = match[1] ?? "";
      // A shell or template interpolation is a reference, not a value. A
      // scanner that cannot tell those apart flags every deployment script
      // there is, and then gets switched off.
      if (/^\$|^\{\{|^%[A-Z_]+%$/.test(value)) return true;
      // Already masked. `***` in a log line is the fix, not the finding.
      if (!/[A-Za-z0-9]/.test(value)) return true;
      return ["postgres", "password", "rescue", "changeme", "secret", "example", "test"].includes(
        value.toLowerCase()
      );
    }
  },
  {
    name: "assigned secret literal",
    /**
     * `API_SECRET = "..."` with something long enough to be real. Deliberately
     * requires a quoted literal of 24 characters or more: shorter values are
     * almost always placeholders, and unquoted ones are almost always
     * references to another variable.
     */
    pattern:
      /\b(?:secret|token|passwd|password|api[_-]?key|private[_-]?key)\w*\s*[:=]\s*["'`]([^"'`\s]{24,})["'`]/i,
    note: "A long literal assigned to something named like a credential.",
    allow: (match) => {
      const value = match[1] ?? "";
      // Placeholders, template syntax, and the repository's own deliberately
      // long test constants, which are named so they can be recognised here.
      return (
        /change[-_]?me|replace[-_]?with|example|placeholder|your[-_]|xxx+|\.\.\./i.test(value) ||
        /^\$\{|^process\.env|^import\.meta/.test(value) ||
        /^test-secret-|^development-only-|^k{24,}$/.test(value)
      );
    }
  }
];

/**
 * A line may opt out, once, with a reason.
 *
 * `pragma: allowlist secret` on the line or the one above it. A scanner with
 * no escape hatch gets disabled wholesale the first time it is wrong.
 */
const PRAGMA = /pragma:\s*allowlist\s+secret/i;

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    const stats = statSync(full);
    if (stats.isDirectory()) {
      yield* walk(full);
      continue;
    }
    if (!stats.isFile()) continue;
    const dot = entry.lastIndexOf(".");
    if (dot > 0 && SKIP_EXTENSIONS.has(entry.slice(dot))) continue;
    // A file large enough to be data rather than source.
    if (stats.size > 2_000_000) continue;
    yield full;
  }
}

const findings = [];
let scanned = 0;

for (const file of walk(ROOT)) {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    continue;
  }
  // A crude but effective binary check: a NUL byte in the first kilobyte.
  if (text.slice(0, 1024).includes("\u0000")) continue;
  scanned += 1;

  const lines = text.split("\n");
  for (const [index, line] of lines.entries()) {
    if (PRAGMA.test(line) || (index > 0 && PRAGMA.test(lines[index - 1] ?? ""))) continue;
    for (const rule of RULES) {
      const match = rule.pattern.exec(line);
      if (!match) continue;
      if (rule.allow?.(match)) continue;
      findings.push({
        file: relative(ROOT, file).split(sep).join("/"),
        line: index + 1,
        rule: rule.name,
        note: rule.note,
        // The matched text is never printed. A scanner that echoes the secret
        // into CI output has put it somewhere with a longer retention than the
        // file it found it in.
        length: match[0].length
      });
    }
  }
}

if (findings.length === 0) {
  console.log(`No secrets found in ${scanned} files.`);
  process.exit(0);
}

console.error(`Found ${findings.length} possible secret${findings.length === 1 ? "" : "s"}:\n`);
for (const finding of findings) {
  console.error(`  ${finding.file}:${finding.line}`);
  console.error(`    ${finding.rule} (${finding.length} characters)`);
  console.error(`    ${finding.note}\n`);
}
console.error(
  [
    "The matched text is not printed here on purpose: it would put the value",
    "into CI logs, which are kept longer and read by more people than the file.",
    "",
    "If a finding is a placeholder, add `pragma: allowlist secret` to the line",
    "or the line above it. If it is real, rotate it first -- removing the commit",
    "does not unpublish it."
  ].join("\n")
);
process.exit(1);
