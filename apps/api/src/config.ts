import { z } from "zod";

const configSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  API_PORT: z.coerce.number().int().positive().default(4000),
  WEB_ORIGIN: z.string().url().default("http://localhost:3000"),
  DATABASE_URL: z.string().min(1).optional(),
  JWT_SECRET: z.string().min(32).default("development-only-secret-change-me-now"),
  AI_PROVIDER: z.enum(["mock", "openai"]).default("mock")
});

export type Config = z.infer<typeof configSchema>;
export const config = configSchema.parse(process.env);
