import { afterEach, describe, expect, it } from "vitest";
import { buildOpenApiDocument } from "../src/openapi.js";
import { harness, type Harness } from "./helpers.js";

let open: Harness | null = null;
afterEach(async () => {
  await open?.close();
  open = null;
});

describe("the OpenAPI document is generated from the contracts", () => {
  const document = buildOpenApiDocument("test") as {
    paths: Record<string, Record<string, { security?: unknown[]; parameters?: { name: string }[] }>>;
    components: { schemas: Record<string, unknown>; securitySchemes: Record<string, unknown> };
    security: unknown[];
  };

  it("declares bearer authentication globally", () => {
    expect(document.security).toEqual([{ bearerAuth: [] }]);
    expect(document.components.securitySchemes.bearerAuth).toBeDefined();
  });

  it("only exempts the endpoints that are genuinely public", () => {
    const exempt = Object.entries(document.paths)
      .flatMap(([path, methods]) =>
        Object.entries(methods)
          .filter(([, operation]) => Array.isArray(operation.security) && operation.security.length === 0)
          .map(([method]) => `${method.toUpperCase()} ${path}`)
      )
      .sort();
    expect(exempt).toEqual(["GET /health", "GET /ready", "POST /auth/dev-token"]);
  });

  it("requires Idempotency-Key on every documented mutation that creates state", () => {
    const mutating = ["/jobs", "/jobs/{id}/quotes", "/quotes/{quoteId}/decision", "/jobs/{id}/offers"];
    for (const path of mutating) {
      const parameters = document.paths[path]!.post!.parameters ?? [];
      expect(parameters.map((parameter) => parameter.name), path).toContain("Idempotency-Key");
    }
  });

  it("generates a JSON Schema for every contract", () => {
    for (const [name, schema] of Object.entries(document.components.schemas)) {
      expect(schema, name).toBeTypeOf("object");
      expect(Object.keys(schema as object).length, name).toBeGreaterThan(0);
    }
  });

  it("does not document an organisation field on job creation", () => {
    const createJob = document.components.schemas.CreateJob as {
      properties: Record<string, unknown>;
    };
    // Finding C2: the client must not be able to name its own tenant.
    expect(Object.keys(createJob.properties)).not.toContain("organizationId");
  });

  it("documents money as integers", () => {
    const quote = document.components.schemas.Quote as {
      properties: Record<string, { type?: string }>;
    };
    for (const field of ["netCents", "vatCents", "grossCents"]) {
      expect(quote.properties[field]!.type, field).toBe("integer");
    }
  });

  it("is served at /v1/openapi.json without credentials", async () => {
    const h = await harness();
    open = h;
    const response = await h.app.inject({ method: "GET", url: "/v1/openapi.json" });
    expect(response.statusCode).toBe(200);
    expect(response.json().openapi).toMatch(/^3\./);
    expect(Object.keys(response.json().paths).length).toBeGreaterThan(15);
  });
});

describe("documented routes exist", () => {
  it("every documented path is registered on the server", async () => {
    const h = await harness();
    open = h;
    const document = buildOpenApiDocument("test") as { paths: Record<string, unknown> };
    // Fastify prints its route table with `:param`; OpenAPI uses `{param}`.
    const registered = h.app
      .printRoutes({ commonPrefix: false })
      .split("\n")
      .join(" ");

    for (const path of Object.keys(document.paths)) {
      const segments = path.split("/").filter(Boolean);
      const leaf = segments.at(-1)!.replace(/[{}]/g, "");
      expect(registered, `${path} (looking for "${leaf}")`).toContain(leaf);
    }
  });
});
