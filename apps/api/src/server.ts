import { buildApp } from "./app.js";
import { config } from "./config.js";

const app = await buildApp();

if (config.jwtSecretIsEphemeral) {
  app.log.warn("JWT_SECRET is unset; using an ephemeral per-process secret. Tokens will not survive a restart.");
}

await app.listen({ port: config.API_PORT, host: config.API_HOST });
