// The generated client, not the `@prisma/client` package.
//
// `prisma generate` writes to `../generated/client` (see schema.prisma for why
// that is explicit). `@prisma/client` re-exports whatever the generator last
// wrote to its default location, which under pnpm is a path no build can name;
// importing the output directly is the same code with a path that survives
// `pnpm deploy`. This is the only file in the repository that names it, so the
// rest of the codebase keeps importing `@rescue/database`.
import { PrismaClient } from "../generated/client/index.js";

export * from "../generated/client/index.js";
export { PrismaClient };

/**
 * Lazy Prisma accessor.
 *
 * Finding M6 in docs/audits/FOUNDATION_AUDIT.md: the previous version built a
 * PrismaClient as a module side effect, so merely importing this package for
 * its types could throw an unhandled initialisation error at import time,
 * before any caller could catch it. Construction now happens on first use.
 */

const globalForPrisma = globalThis as unknown as { __rescuePrisma?: PrismaClient };

export function createPrismaClient(databaseUrl?: string): PrismaClient {
  return new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
    ...(databaseUrl ? { datasources: { db: { url: databaseUrl } } } : {})
  });
}

/**
 * Process-wide client. Reused across hot reloads in development so a watch
 * loop does not exhaust the connection pool, but never cached in production
 * where the process is long-lived anyway.
 */
export function getDb(databaseUrl?: string): PrismaClient {
  if (process.env.NODE_ENV === "production") {
    return createPrismaClient(databaseUrl);
  }
  globalForPrisma.__rescuePrisma ??= createPrismaClient(databaseUrl);
  return globalForPrisma.__rescuePrisma;
}

export async function disconnectDb(): Promise<void> {
  if (globalForPrisma.__rescuePrisma) {
    await globalForPrisma.__rescuePrisma.$disconnect();
    globalForPrisma.__rescuePrisma = undefined;
  }
}
