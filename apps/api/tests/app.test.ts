import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";

const apps: Awaited<ReturnType<typeof buildApp>>[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.close())); });

describe("RESCUE API", () => {
  it("reports health", async () => {
    const app = await buildApp(); apps.push(app);
    const response = await app.inject({ method: "GET", url: "/v1/health" });
    expect(response.statusCode).toBe(200); expect(response.json().status).toBe("ok");
  });

  it("creates a job and returns human-reviewed triage", async () => {
    const app = await buildApp(); apps.push(app);
    const response = await app.inject({ method: "POST", url: "/v1/jobs", payload: {
      organizationId: "22222222-2222-4222-8222-222222222222", type: "FAILED_DELIVERY", urgency: "SAME_DAY",
      pickup: { line1: "Am Markt 1", postalCode: "28195", city: "Bremen", countryCode: "DE" },
      destination: { line1: "Parkallee 10", postalCode: "28209", city: "Bremen", countryCode: "DE" },
      items: [{ name: "Sofa", quantity: 1, estimatedWeightKg: 85 }], stairs: 2, liftAvailable: false
    }});
    expect(response.statusCode).toBe(201);
    const body=response.json(); expect(body.data.job.status).toBe("DRAFT"); expect(body.data.triage.requiresHumanApproval).toBe(true);
  });

  it("rejects an invalid German postal code", async () => {
    const app = await buildApp(); apps.push(app);
    const response = await app.inject({ method: "POST", url: "/v1/jobs", payload: { organizationId: "bad", type: "FAILED_DELIVERY", urgency: "URGENT", pickup: { line1: "X", postalCode: "28", city: "B" }, items: [] } });
    expect(response.statusCode).toBe(400); expect(response.json().error.code).toBe("VALIDATION_ERROR");
  });
});
