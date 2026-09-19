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

/** Every table the suite expects, so a partial schema is named, not inferred. */
const REQUIRED_TABLES = [
  "User",
  "Membership",
  "Organization",
  "Provider",
  "Vehicle",
  "ProviderDocument",
  "Job",
  "Quote",
  "AssignmentOffer",
  "Assignment",
  "Evidence",
  "JobEvent",
  "AuditLog",
  "IdempotencyKey",
  "OutboxMessage",
  "LedgerEntry",
  "Suggestion"
] as const;

/**
 * Says what is wrong before the suite tries to use the database.
 *
 * Without this, an unreachable server or an un-migrated database produces
 * eighteen identical Prisma stack traces pointing at a TRUNCATE, which says
 * nothing about the actual problem. Each branch below is a mistake somebody
 * will really make, answered with the command that fixes it.
 */
async function assertUsable(db: {
  $queryRawUnsafe: (query: string) => Promise<unknown>;
}): Promise<void> {
  let present: string[];
  try {
    const rows = (await db.$queryRawUnsafe(
      `SELECT tablename FROM pg_tables WHERE schemaname = 'public'`
    )) as { tablename: string }[];
    present = rows.map((row) => row.tablename);
  } catch (error) {
    const detail = error instanceof Error ? error.message.split("\n")[0] : String(error);
    throw new Error(
      [
        `Cannot reach the database at DATABASE_URL.`,
        `  ${detail}`,
        ``,
        `Start PostgreSQL and create the scratch database:`,
        `  createdb rescue_test`,
        `If the server is running on another port or host, set DATABASE_URL to match.`
      ].join("\n")
    );
  }

  const missing = REQUIRED_TABLES.filter((table) => !present.includes(table));
  if (missing.length === REQUIRED_TABLES.length) {
    throw new Error(
      [
        `The database at DATABASE_URL is empty: no tables at all.`,
        ``,
        `Apply the migrations to it first:`,
        `  DATABASE_URL=$DATABASE_URL pnpm --filter @rescue/database exec prisma migrate deploy`
      ].join("\n")
    );
  }
  if (missing.length > 0) {
    throw new Error(
      [
        `The database is behind the schema. Missing: ${missing.join(", ")}.`,
        ``,
        `Apply the outstanding migrations:`,
        `  DATABASE_URL=$DATABASE_URL pnpm --filter @rescue/database exec prisma migrate deploy`
      ].join("\n")
    );
  }
}
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
      await assertUsable(db);

      // Every table, children first. CASCADE would reach the rest anyway, but
      // naming them means adding a table to the schema and forgetting it here
      // shows up as a compile-time-ish omission in review rather than as a
      // mysterious row surviving between cases.
      await db.$executeRawUnsafe(`
        TRUNCATE TABLE "JobEvent", "AuditLog", "Evidence", "Assignment", "AssignmentOffer",
                       "Quote", "IdempotencyKey", "OutboxMessage", "LedgerEntry", "Suggestion",
                       "Job", "ProviderDocument", "Vehicle",
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
