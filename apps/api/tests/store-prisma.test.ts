import { describe, it } from "vitest";
import { runStoreConformance } from "./store-conformance.js";

/**
 * The same conformance suite, against real PostgreSQL.
 *
 * Skipped unless DATABASE_URL points at a database with the migrations
 * applied. To run it:
 *
 *   createdb rescue_test
 *   DATABASE_URL=postgresql://localhost:5432/rescue_test pnpm --filter @rescue/database exec prisma migrate deploy
 *   DATABASE_URL=postgresql://localhost:5432/rescue_test pnpm --filter @rescue/api test
 *
 * It truncates every table between cases, so point it at a scratch database,
 * never a real one. The guard below refuses anything that looks like it is not
 * a test database.
 */

const DATABASE_URL = process.env.DATABASE_URL;
const looksLikeTestDatabase =
  DATABASE_URL !== undefined && /test|scratch|ci/i.test(DATABASE_URL);

if (DATABASE_URL && !looksLikeTestDatabase) {
  describe("PrismaStore conformance", () => {
    it.skip(
      "refuses to run: DATABASE_URL does not look like a test database (needs 'test', 'scratch' or 'ci' in the name)",
      () => undefined
    );
  });
} else if (!DATABASE_URL) {
  describe("PrismaStore conformance", () => {
    it.skip("skipped: set DATABASE_URL to a scratch database to run the Prisma store against PostgreSQL", () =>
      undefined);
  });
} else {
  const ORG_A = "11111111-1111-4111-8111-111111111111";
  const ORG_B = "22222222-2222-4222-8222-222222222222";
  const PROVIDER_A = "33333333-3333-4333-8333-333333333333";
  const PROVIDER_B = "44444444-4444-4444-8444-444444444444";
  const USER = "aaaa1111-1111-4111-8111-111111111111";

  runStoreConformance("PrismaStore", {
    async create() {
      const [{ getDb }, { PrismaStore }] = await Promise.all([
        import("@rescue/database"),
        import("../src/store/prisma.js")
      ]);
      const db = getDb(DATABASE_URL);

      // Order matters: children before parents. JobEvent and AuditLog are
      // append-only for the application role, so this needs a superuser or an
      // owner connection -- which a scratch database has.
      await db.$executeRawUnsafe(`
        TRUNCATE TABLE "JobEvent", "AuditLog", "Evidence", "Assignment", "AssignmentOffer",
                       "Quote", "IdempotencyKey", "Job", "ProviderDocument", "Vehicle",
                       "Membership", "Provider", "Organization", "User"
        RESTART IDENTITY CASCADE
      `);

      await db.organization.createMany({
        data: [
          { id: ORG_A, name: "Org A" },
          { id: ORG_B, name: "Org B" }
        ]
      });
      await db.provider.createMany({
        data: [
          {
            id: PROVIDER_A,
            legalName: "Provider A",
            status: "ACTIVE",
            basePostalCode: "28195",
            serviceRadiusKm: 50,
            serviceTypes: ["FAILED_DELIVERY"],
            contactEmail: "a@example.com"
          },
          {
            id: PROVIDER_B,
            legalName: "Provider B",
            status: "ACTIVE",
            basePostalCode: "28195",
            serviceRadiusKm: 50,
            serviceTypes: ["FAILED_DELIVERY"],
            contactEmail: "b@example.com"
          }
        ]
      });
      await db.user.create({
        data: { id: USER, subject: "test|dispatcher", email: "d@example.com", name: "Dispatcher" }
      });

      return {
        store: new PrismaStore(db),
        organizationA: ORG_A,
        organizationB: ORG_B,
        providerA: PROVIDER_A,
        providerB: PROVIDER_B,
        actor: { userId: USER, role: "DISPATCHER" as const }
      };
    }
  });
}
