import { randomBytes } from "node:crypto";
import { z } from "zod";

/**
 * Secrets that have appeared in this repository or its documentation. They are
 * long enough to satisfy the length check, so they must be rejected by value.
 */
const PLACEHOLDER_SECRETS = new Set([
  "development-only-secret-change-me-now",
  "replace-with-at-least-32-random-characters"
]);

const SECRET_HINT = "Generate one with: openssl rand -base64 48";

const baseSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  API_PORT: z.coerce.number().int().positive().default(4000),
  /**
   * Loopback by default so `pnpm dev` never publishes the API to the local
   * network. Container images set this to 0.0.0.0 explicitly.
   */
  API_HOST: z.string().min(1).default("127.0.0.1"),
  WEB_ORIGIN: z.string().url().default("http://localhost:3000"),

  /** Absent means the in-memory store. Present selects Prisma/PostgreSQL. */
  DATABASE_URL: z.string().min(1).optional(),

  /**
   * Required in production. In development and test an ephemeral secret is
   * generated per process, so no usable signing key is ever committed.
   */
  JWT_SECRET: z.string().min(32).optional(),

  /**
   * Real identity provider. When both are set the API verifies tokens against
   * the provider's JWKS and the development issuer is disabled entirely.
   */
  OIDC_ISSUER: z.string().url().optional(),
  OIDC_JWKS_URI: z.string().url().optional(),
  OIDC_AUDIENCE: z.string().min(1).default("rescue-api"),

  /**
   * Number of reverse proxies in front of the API. 0 disables X-Forwarded-For
   * trust, which keeps rate limiting keyed on the real peer address.
   */
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(10).default(0),

  /**
   * Requests per minute per caller. 100 is fine for a customer but low for a
   * dispatcher working a queue, who can issue that many in a few minutes of
   * normal use. Tune per deployment rather than hardcoding.
   */
  RATE_LIMIT_MAX: z.coerce.number().int().min(1).max(100_000).default(300),

  /** Keys the vehicle-registration hash. Registrations are never stored raw. */
  REGISTRATION_HASH_KEY: z.string().min(32).optional(),

  /** How long a replayed Idempotency-Key keeps returning the stored response. */
  IDEMPOTENCY_TTL_HOURS: z.coerce.number().int().min(1).max(168).default(24),

  /** Object storage for evidence. The mock signer is refused in production. */
  STORAGE_PROVIDER: z.enum(["mock", "s3"]).default("mock"),
  S3_ENDPOINT: z.string().url().optional(),
  S3_BUCKET: z.string().min(1).default("rescue-dev"),
  S3_ACCESS_KEY: z.string().optional(),
  S3_SECRET_KEY: z.string().optional(),
  EVIDENCE_UPLOAD_TTL_SECONDS: z.coerce.number().int().min(60).max(3600).default(900),

  AI_PROVIDER: z.enum(["mock", "openai"]).default("mock")
});

function ephemeralSecret(): string {
  return randomBytes(48).toString("base64");
}

const configSchema = baseSchema
  .superRefine((value, ctx) => {
    const isProduction = value.NODE_ENV === "production";

    for (const field of ["JWT_SECRET", "REGISTRATION_HASH_KEY"] as const) {
      const secret = value[field];
      if (secret !== undefined && PLACEHOLDER_SECRETS.has(secret)) {
        ctx.addIssue({
          code: "custom",
          path: [field],
          message: `${field} is set to a known placeholder value. ${SECRET_HINT}`
        });
      }
    }

    if (isProduction) {
      if (value.JWT_SECRET === undefined && value.OIDC_ISSUER === undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["OIDC_ISSUER"],
          message: `Production requires a real identity provider: set OIDC_ISSUER and OIDC_JWKS_URI. ${SECRET_HINT} only applies to development.`
        });
      }
      if (value.REGISTRATION_HASH_KEY === undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["REGISTRATION_HASH_KEY"],
          message: `REGISTRATION_HASH_KEY must be set in production. ${SECRET_HINT}`
        });
      }
      if (value.DATABASE_URL === undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["DATABASE_URL"],
          message: "DATABASE_URL must be set in production; the in-memory store loses data on restart"
        });
      }
      if (value.STORAGE_PROVIDER === "mock") {
        ctx.addIssue({
          code: "custom",
          path: ["STORAGE_PROVIDER"],
          message: "STORAGE_PROVIDER=mock does not store anything and is refused in production"
        });
      }
      if (value.WEB_ORIGIN === "*") {
        ctx.addIssue({ code: "custom", path: ["WEB_ORIGIN"], message: "WEB_ORIGIN may not be a wildcard" });
      }
    }

    // A half-configured identity provider is worse than none: it would fall
    // back to the development issuer without anyone noticing.
    if ((value.OIDC_ISSUER === undefined) !== (value.OIDC_JWKS_URI === undefined)) {
      ctx.addIssue({
        code: "custom",
        path: ["OIDC_JWKS_URI"],
        message: "OIDC_ISSUER and OIDC_JWKS_URI must be set together"
      });
    }
  })
  .transform((value) => ({
    ...value,
    JWT_SECRET: value.JWT_SECRET ?? ephemeralSecret(),
    REGISTRATION_HASH_KEY: value.REGISTRATION_HASH_KEY ?? ephemeralSecret(),
    jwtSecretIsEphemeral: value.JWT_SECRET === undefined,
    /** Fastify expects `false` rather than `0` to disable proxy trust. */
    trustProxy: value.TRUST_PROXY_HOPS === 0 ? (false as const) : value.TRUST_PROXY_HOPS,
    /** True when a real identity provider is configured. */
    usesOidc: value.OIDC_ISSUER !== undefined && value.OIDC_JWKS_URI !== undefined,
    /**
     * The development token endpoint exists only when there is no real IdP and
     * we are not in production. Both conditions, not either.
     */
    devIdentityEnabled:
      value.NODE_ENV !== "production" && value.OIDC_ISSUER === undefined
  }));

export type Config = z.infer<typeof configSchema>;

/**
 * An environment variable set to the empty string means "not set".
 *
 * `.env` templates, docker-compose defaults and CI runners all routinely
 * produce `FOO=`. Without this, `DATABASE_URL=` in a copied `.env.example`
 * fails `min(1)` and the process refuses to boot with a confusing message
 * about a field the operator deliberately left blank.
 */
function blankAsUnset(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const cleaned: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== "") cleaned[key] = value;
  }
  return cleaned;
}

/** Exported for tests; production code should use the `config` singleton. */
export function parseConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return configSchema.parse(blankAsUnset(env));
}

export const config = parseConfig();
