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
  DATABASE_URL: z.string().min(1).optional(),
  /**
   * Required in production. In development and test an ephemeral secret is
   * generated per process, so no usable signing key is ever committed.
   */
  JWT_SECRET: z.string().min(32).optional(),
  /**
   * Number of reverse proxies in front of this service. 0 means do not trust
   * X-Forwarded-For at all, which keeps the rate limiter keyed on the real
   * peer address. Only raise this to the number of proxies you actually run.
   */
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(10).default(0),
  AI_PROVIDER: z.enum(["mock", "openai"]).default("mock")
});

const configSchema = baseSchema
  .superRefine((value, ctx) => {
    if (value.JWT_SECRET !== undefined && PLACEHOLDER_SECRETS.has(value.JWT_SECRET)) {
      ctx.addIssue({
        code: "custom",
        path: ["JWT_SECRET"],
        message: `JWT_SECRET is set to a known placeholder value. ${SECRET_HINT}`
      });
      return;
    }

    if (value.NODE_ENV === "production" && value.JWT_SECRET === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["JWT_SECRET"],
        message: `JWT_SECRET must be set in production. ${SECRET_HINT}`
      });
    }
  })
  .transform((value) => ({
    ...value,
    JWT_SECRET: value.JWT_SECRET ?? randomBytes(48).toString("base64"),
    /** True when the signing key is ephemeral and will not survive a restart. */
    jwtSecretIsEphemeral: value.JWT_SECRET === undefined,
    /** Fastify expects `false` rather than `0` to disable proxy trust. */
    trustProxy: value.TRUST_PROXY_HOPS === 0 ? (false as const) : value.TRUST_PROXY_HOPS
  }));

export type Config = z.infer<typeof configSchema>;

/** Exported for tests; production code should use the `config` singleton. */
export function parseConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return configSchema.parse(env);
}

export const config = parseConfig();
