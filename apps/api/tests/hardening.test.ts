import { afterEach, describe, expect, it } from "vitest";
import { buildApp, buildVerifier } from "../src/app.js";
import { parseConfig } from "../src/config.js";
import { testConfig } from "./helpers.js";

const apps: Awaited<ReturnType<typeof buildApp>>[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

/** A production environment with every required value present. */
const PRODUCTION_ENV = {
  NODE_ENV: "production",
  OIDC_ISSUER: "https://idp.example.com",
  OIDC_JWKS_URI: "https://idp.example.com/.well-known/jwks.json",
  REGISTRATION_HASH_KEY: "a-production-registration-key-long-enough",
  DATABASE_URL: "postgresql://rescue@db:5432/rescue",
  STORAGE_PROVIDER: "s3"
} as const;

describe("secrets (H3)", () => {
  it("rejects the placeholder that shipped in config.ts", () => {
    expect(() => parseConfig({ JWT_SECRET: "development-only-secret-change-me-now" })).toThrow(
      /placeholder/i
    );
  });

  it("rejects the placeholder that ships in .env.example", () => {
    expect(() => parseConfig({ JWT_SECRET: "replace-with-at-least-32-random-characters" })).toThrow(
      /placeholder/i
    );
  });

  it("rejects a placeholder used as the registration hash key", () => {
    expect(() =>
      parseConfig({ REGISTRATION_HASH_KEY: "development-only-secret-change-me-now" })
    ).toThrow(/placeholder/i);
  });

  it("generates a distinct ephemeral secret per process in development", () => {
    const first = parseConfig({});
    const second = parseConfig({});
    expect(first.jwtSecretIsEphemeral).toBe(true);
    expect(first.JWT_SECRET).not.toBe(second.JWT_SECRET);
    expect(first.JWT_SECRET.length).toBeGreaterThanOrEqual(32);
  });
});

describe("production refuses to boot half-configured", () => {
  it("accepts a fully configured production environment", () => {
    const config = parseConfig(PRODUCTION_ENV);
    expect(config.usesOidc).toBe(true);
    expect(config.devIdentityEnabled).toBe(false);
  });

  it.each([
    ["OIDC_ISSUER", /identity provider/i],
    ["REGISTRATION_HASH_KEY", /REGISTRATION_HASH_KEY/],
    ["DATABASE_URL", /DATABASE_URL/],
    ["STORAGE_PROVIDER", /does not store anything/]
  ])("refuses production without %s", (field, message) => {
    const env: Record<string, string> = { ...PRODUCTION_ENV };
    delete env[field];
    if (field === "OIDC_ISSUER") delete env.OIDC_JWKS_URI;
    if (field === "STORAGE_PROVIDER") env.STORAGE_PROVIDER = "mock";
    expect(() => parseConfig(env)).toThrow(message);
  });

  it("refuses a half-configured identity provider", () => {
    expect(() => parseConfig({ OIDC_ISSUER: "https://idp.example.com" })).toThrow(/must be set together/);
    expect(() =>
      parseConfig({ OIDC_JWKS_URI: "https://idp.example.com/.well-known/jwks.json" })
    ).toThrow(/must be set together/);
  });

  it("refuses a wildcard CORS origin in production", () => {
    expect(() => parseConfig({ ...PRODUCTION_ENV, WEB_ORIGIN: "*" })).toThrow();
  });

  it("will not construct the symmetric dev verifier in production", () => {
    const config = parseConfig({ ...PRODUCTION_ENV });
    // With OIDC configured it builds the real one...
    expect(buildVerifier(config).kind).toBe("oidc");
    // ...and without it, it refuses rather than silently downgrading.
    const broken = { ...config, usesOidc: false } as typeof config;
    expect(() => buildVerifier(broken)).toThrow(/Refusing to start/);
  });

  it("disables the development token endpoint outside development", () => {
    expect(parseConfig({ NODE_ENV: "development" }).devIdentityEnabled).toBe(true);
    expect(parseConfig({ ...PRODUCTION_ENV }).devIdentityEnabled).toBe(false);
    // A real IdP disables it even in development.
    expect(
      parseConfig({
        OIDC_ISSUER: "https://idp.example.com",
        OIDC_JWKS_URI: "https://idp.example.com/jwks"
      }).devIdentityEnabled
    ).toBe(false);
  });
});

describe("network exposure (H6, H1)", () => {
  it("binds loopback by default", () => {
    expect(parseConfig({}).API_HOST).toBe("127.0.0.1");
  });

  it("still allows an explicit container bind", () => {
    expect(parseConfig({ API_HOST: "0.0.0.0" }).API_HOST).toBe("0.0.0.0");
  });

  it("does not trust X-Forwarded-For by default", () => {
    expect(parseConfig({}).trustProxy).toBe(false);
  });

  it("trusts exactly the configured number of hops", () => {
    expect(parseConfig({ TRUST_PROXY_HOPS: "1" }).trustProxy).toBe(1);
  });
});

describe("rate limiting (H1, H2)", () => {
  it("returns 429 with the documented error envelope, not 500", async () => {
    const app = await buildApp({ config: testConfig(), rateLimitMax: 2 });
    apps.push(app);
    await app.listen({ port: 0, host: "127.0.0.1" });
    const address = app.server.address();
    if (address === null || typeof address === "string") throw new Error("expected a TCP address");
    const base = `http://127.0.0.1:${address.port}/v1/health`;

    const statuses: number[] = [];
    for (let i = 0; i < 4; i++) statuses.push((await fetch(base)).status);

    expect(statuses.slice(0, 2)).toEqual([200, 200]);
    expect(statuses.slice(2)).toEqual([429, 429]);

    const throttled = await fetch(base);
    expect(throttled.headers.get("retry-after")).not.toBeNull();
    expect((await throttled.json()).error.code).toBe("RATE_LIMITED");
  });

  it("cannot be bypassed by spoofing X-Forwarded-For", async () => {
    const app = await buildApp({ config: testConfig(), rateLimitMax: 2 });
    apps.push(app);
    await app.listen({ port: 0, host: "127.0.0.1" });
    const address = app.server.address();
    if (address === null || typeof address === "string") throw new Error("expected a TCP address");
    const base = `http://127.0.0.1:${address.port}/v1/health`;

    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) {
      statuses.push((await fetch(base, { headers: { "x-forwarded-for": `203.0.113.${i}` } })).status);
    }
    // Before the fix every one of these returned 200, because each spoofed
    // address got its own bucket.
    expect(statuses.filter((status) => status === 429).length).toBe(4);
  });
});

describe("empty environment variables mean unset", () => {
  it("treats DATABASE_URL= as absent rather than invalid", () => {
    // `cp .env.example .env` produces exactly this.
    expect(() => parseConfig({ DATABASE_URL: "" })).not.toThrow();
    expect(parseConfig({ DATABASE_URL: "" }).DATABASE_URL).toBeUndefined();
  });

  it("treats blank secrets and URLs as absent", () => {
    const config = parseConfig({ JWT_SECRET: "", OIDC_ISSUER: "", REGISTRATION_HASH_KEY: "" });
    expect(config.jwtSecretIsEphemeral).toBe(true);
    expect(config.usesOidc).toBe(false);
  });

  it("still refuses production when the required values are blank", () => {
    expect(() => parseConfig({ ...PRODUCTION_ENV, OIDC_ISSUER: "", OIDC_JWKS_URI: "" })).toThrow();
  });
});
