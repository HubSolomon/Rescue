import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { parseConfig } from "../src/config.js";

/**
 * The demo gate.
 *
 * This exists so the API can be publicly reachable while running with the
 * development sign-in enabled -- an endpoint that mints a dispatcher session
 * for anyone who asks. The gate is the only thing between that endpoint and
 * the internet, so what these tests care about is not that it lets the right
 * request through, but that there is no request it wrongly lets through.
 */

const KEY = "a-demo-key-long-enough-to-pass-validation";

const BASE = {
  NODE_ENV: "test" as const,
  JWT_SECRET: "test-secret-that-is-long-enough-to-pass-validation",
  REGISTRATION_HASH_KEY: "test-secret-that-is-long-enough-to-pass-validation"
};

const gated = () => buildApp({ config: parseConfig({ ...BASE, DEMO_API_KEY: KEY }) });
const ungated = () => buildApp({ config: parseConfig(BASE) });

describe("with a key configured, nothing unkeyed gets through", () => {
  it("refuses the development sign-in, which is the whole reason it exists", async () => {
    const app = await gated();
    const response = await app.inject({
      method: "POST",
      url: "/v1/auth/dev-token",
      payload: { subject: "dev|dispatcher" }
    });
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe("NOT_FOUND");
    await app.close();
  });

  it("refuses it with a wrong key too", async () => {
    const app = await gated();
    const response = await app.inject({
      method: "POST",
      url: "/v1/auth/dev-token",
      headers: { "x-demo-key": "not-the-key-but-the-same-sort-of-length" },
      payload: { subject: "dev|dispatcher" }
    });
    expect(response.statusCode).toBe(404);
    await app.close();
  });

  it("refuses a key that is a prefix of the real one", async () => {
    const app = await gated();
    const response = await app.inject({
      url: "/v1/openapi.json",
      headers: { "x-demo-key": KEY.slice(0, -1) }
    });
    expect(response.statusCode).toBe(404);
    await app.close();
  });

  it("refuses the documentation and readiness endpoints, which are not liveness", async () => {
    // /v1/ready reports on the database. That is a fact about the deployment,
    // and there is no reason an anonymous caller should learn it.
    const app = await gated();
    for (const url of ["/v1/openapi.json", "/v1/ready", "/metrics"]) {
      const response = await app.inject({ url });
      expect(response.statusCode, url).toBe(404);
    }
    await app.close();
  });

  it("answers liveness without the key, so the orchestrator can reach it", async () => {
    const app = await gated();
    const response = await app.inject({ url: "/v1/health" });
    expect(response.statusCode).toBe(200);
    await app.close();
  });

  it("lets a correctly keyed request reach the route it asked for", async () => {
    const app = await gated();
    const response = await app.inject({
      url: "/v1/openapi.json",
      headers: { "x-demo-key": KEY }
    });
    expect(response.statusCode).toBe(200);
    await app.close();
  });

  it("is not satisfied by a query parameter, which would end up in access logs", async () => {
    const app = await gated();
    const response = await app.inject({ url: `/v1/openapi.json?x-demo-key=${KEY}` });
    expect(response.statusCode).toBe(404);
    await app.close();
  });
});

describe("with no key configured, it is not there at all", () => {
  it("does not gate anything", async () => {
    const app = await ungated();
    expect((await app.inject({ url: "/v1/openapi.json" })).statusCode).toBe(200);
    await app.close();
  });

  it("still refuses an authenticated route, so the gate is not what protects those", async () => {
    // The point: removing the gate must not be the thing that opens the API.
    // Authentication is separate and still applies.
    const app = await ungated();
    expect((await app.inject({ url: "/v1/jobs" })).statusCode).toBe(401);
    await app.close();
  });
});

describe("the key itself", () => {
  it("is refused if it is short enough to guess", () => {
    expect(() => parseConfig({ ...BASE, DEMO_API_KEY: "tooshort" })).toThrow();
  });
});
