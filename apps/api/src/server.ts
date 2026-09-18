import { buildApp } from "./app.js";
import { config } from "./config.js";

const app = await buildApp();
await app.listen({ port: config.API_PORT, host: "0.0.0.0" });
