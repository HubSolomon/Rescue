#!/usr/bin/env node
/**
 * Checks a production environment before anything is deployed with it.
 *
 * `parseConfig` already refuses to boot on a bad configuration, and that is
 * the real guarantee. But discovering it at boot means the discovery happens
 * inside a container, in an orchestrator's restart loop, with the error in a
 * log somebody has to go and find — and for a first deployment, usually
 * several times in a row over an hour.
 *
 * This is the same knowledge, ten seconds earlier, on a terminal. It does not
 * replace the boot check and is not authoritative: it is the thing that saves
 * the hour.
 *
 *   node scripts/check-deploy-env.mjs .env.production
 *   env $(cat .env.production | xargs) node scripts/check-deploy-env.mjs
 */

import { readFileSync } from "node:fs";

const file = process.argv[2];
const env = { ...process.env };

if (file) {
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    env[match[1]] = match[2].replace(/^["']|["']$/g, "");
  }
}

const problems = [];
const warnings = [];

const has = (name) => typeof env[name] === "string" && env[name].length > 0;
const need = (name, why) => { if (!has(name)) problems.push([name, why]); };
const warn = (name, why) => warnings.push([name, why]);

if (env.NODE_ENV !== "production") {
  problems.push(["NODE_ENV", 'must be "production" — otherwise the development identity provider stays enabled and anyone can sign in as any seeded person']);
}

/* ------------------------------------------------------------- identity */
need("OIDC_ISSUER", "production has no password-less sign-in; the API refuses to start without a real identity provider");
need("OIDC_JWKS_URI", "the public keys the API verifies tokens against");
if (has("OIDC_ISSUER") !== has("OIDC_JWKS_URI")) {
  problems.push(["OIDC_JWKS_URI", "set both or neither — a half-configured provider silently falls back to the development issuer"]);
}

/* -------------------------------------------------------------- secrets */
for (const [name, why] of [
  ["JWT_SECRET", "signs the session cookie"],
  ["REGISTRATION_HASH_KEY", "keys the vehicle-registration hash — changing it later orphans every stored hash permanently"]
]) {
  need(name, why);
  if (has(name) && env[name].length < 32) problems.push([name, "must be at least 32 characters. Generate: openssl rand -base64 48"]);
}
if (has("METRICS_TOKEN") && env.METRICS_TOKEN.length < 16) {
  problems.push(["METRICS_TOKEN", "must be at least 16 characters"]);
}
if (!has("METRICS_TOKEN")) {
  warn("METRICS_TOKEN", "unset, so /metrics will not exist in production and no alert can fire. Generate: openssl rand -hex 24");
}

/* ------------------------------------------------------------- database */
need("DATABASE_URL", "the in-memory store loses every job on restart");
if (has("DATABASE_URL") && !/^postgres(ql)?:\/\//.test(env.DATABASE_URL)) {
  problems.push(["DATABASE_URL", "must be a postgresql:// URL"]);
}
if (has("DATABASE_URL") && /localhost|127\.0\.0\.1/.test(env.DATABASE_URL)) {
  warn("DATABASE_URL", "points at localhost, which inside a container is the container itself");
}
if (has("DATABASE_URL") && !/sslmode=/.test(env.DATABASE_URL)) {
  warn("DATABASE_URL", "no sslmode — most managed providers want sslmode=require");
}

/* -------------------------------------------------------------- storage */
if (env.STORAGE_PROVIDER !== "s3") {
  problems.push(["STORAGE_PROVIDER", 'must be "s3" in production; the mock signs URLs for a bucket that does not exist']);
}
need("S3_BUCKET", "where evidence photographs go");
need("S3_ACCESS_KEY", "the bucket credential the presigner signs with");
need("S3_SECRET_KEY", "the secret half of that credential — never echoed by this script");
need("S3_REGION", "SigV4 signs over the region; a mismatch is rejected by the bucket");
if (has("S3_ENDPOINT") && env.S3_ADDRESSING === undefined) {
  warn("S3_ADDRESSING", "an endpoint is set, so path addressing is assumed. Set virtual-host explicitly if the gateway wants it");
}

/* --------------------------------------------------------------- origin */
need("WEB_ORIGIN", "CORS; the browser refuses the API without it");
if (env.WEB_ORIGIN === "*") problems.push(["WEB_ORIGIN", "may not be a wildcard"]);
if (has("WEB_ORIGIN") && env.WEB_ORIGIN.startsWith("http://")) {
  problems.push(["WEB_ORIGIN", "must be https in production — the session cookie will not survive a plain-http origin"]);
}
if (!has("NEXT_PUBLIC_API_URL")) {
  problems.push(["NEXT_PUBLIC_API_URL", "is baked into the web image at BUILD time, not read at boot. Pass it as a build argument or the browser will call localhost"]);
}

/* ---------------------------------------------------------------- proxy */
if (env.TRUST_PROXY_HOPS === undefined || env.TRUST_PROXY_HOPS === "0") {
  warn("TRUST_PROXY_HOPS", "0 behind a load balancer means every client shares one rate-limit bucket keyed on the balancer's address. Set it to the number of proxies you actually run — no more, or clients can forge their own IP");
}

/* ----------------------------------------------------------------- maps */
if (env.MAPS_PROVIDER === "osm" && !has("MAPS_USER_AGENT")) {
  problems.push(["MAPS_USER_AGENT", "Nominatim's policy requires a contactable agent; a generic one gets the deployment blocked"]);
}
if (env.MAPS_PROVIDER !== "osm") {
  warn("MAPS_PROVIDER", "not osm, so every distance is a postal-code estimate. It is flagged in the console as not a road distance, but eligibility uses it");
}

/* --------------------------------------------------------- placeholders */
// A value that looks like it came from a template is worse than a missing one:
// it passes a length check and fails silently.
for (const [name, value] of Object.entries(env)) {
  if (typeof value !== "string") continue;
  if (/change[-_]?me|replace[-_]?with|your[-_]|example\.com|xxx+/i.test(value) && /SECRET|KEY|TOKEN|URL|ISSUER/.test(name)) {
    problems.push([name, "still looks like a template placeholder"]);
  }
}

/* --------------------------------------------------------------- report */
const label = file ? file : "the current environment";
if (problems.length === 0) {
  console.log(`${label}: ready to deploy.`);
} else {
  console.error(`${label}: ${problems.length} problem${problems.length === 1 ? "" : "s"}.\n`);
  for (const [name, why] of problems) console.error(`  ${name}\n      ${why}\n`);
}

if (warnings.length > 0) {
  console.error(`${warnings.length} thing${warnings.length === 1 ? "" : "s"} worth a look:\n`);
  for (const [name, why] of warnings) console.error(`  ${name}\n      ${why}\n`);
}

// Values are never printed, only names. This runs in terminals and CI logs.
process.exit(problems.length === 0 ? 0 : 1);
