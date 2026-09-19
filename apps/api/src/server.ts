import { buildApp } from "./app.js";
import { config } from "./config.js";

const app = await buildApp();

if (config.jwtSecretIsEphemeral && !config.usesOidc) {
  app.log.warn("JWT_SECRET is unset; using an ephemeral per-process secret. Tokens will not survive a restart.");
}
if (!config.DATABASE_URL) {
  app.log.warn("DATABASE_URL is unset; using the in-memory store. Nothing is persisted across restarts.");
}
if (config.devIdentityEnabled) {
  app.log.warn("Development identity provider is enabled at POST /v1/auth/dev-token.");
}

await app.listen({ port: config.API_PORT, host: config.API_HOST });

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    app.log.info({ signal }, "shutting down");
    void app.close().then(() => process.exit(0));
  });
}
