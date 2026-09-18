import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { parseConfig } from "../src/config.js";

const apps: Awaited<ReturnType<typeof buildApp>>[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe("config: JWT_SECRET (H3)", () => {
  it("rejects the placeholder that shipped in config.ts", () => {
    expect(() => parseConfig({ JWT_SECRET: "development-only-secret-change-me-now" })).toThrow(/placeholder/i);
  });

  it("rejects the placeholder that ships in .env.example", () => {
    expect(() => parseConfig({ JWT_SECRET: "replace-with-at-least-32-random-characters" })).toThrow(/placeholder/i);
  });

  it("refuses to start in production without a secret", () => {
    expect(() => parseConfig({ NODE_ENV: "production" })).toThrow(/must be set in production/i);
  });

  it("starts in production with a real secret", () => {
    const secret = "S6m0aGJ3xQ2pR8vL1nT4dYw7KzB5cF9hUeA0iOqXjMrN";
    expect(parseConfig({ NODE_ENV: "production", JWT_SECRET: secret }).JWT_SECRET).toBe(secret);
  });

  it("generates a distinct ephemeral secret per process in development", () => {
    const first = parseConfig({});
    const second = parseConfig({});
    expect(first.jwtSecretIsEphemeral).toBe(true);
    expect(first.JWT_SECRET).not.toBe(second.JWT_SECRET);
    expect(first.JWT_SECRET.length).toBeGreaterThanOrEqual(32);
  });
});

describe("config: network exposure (H6, H1)", () => {
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
    const app = await buildApp({ rateLimitMax: 2 });
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
    expect(throttled.status).toBe(429);
    expect(throttled.headers.get("retry-after")).not.toBeNull();
    expect((await throttled.json()).error.code).toBe("RATE_LIMITED");
  });

  it("cannot be bypassed by spoofing X-Forwarded-For", async () => {
    const app = await buildApp({ rateLimitMax: 2 });
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
