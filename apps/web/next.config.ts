import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  /**
   * `standalone` traces the files the server actually imports and writes them,
   * with a minimal `node_modules`, into `.next/standalone`. The production
   * image copies that instead of the workspace, which takes it from roughly a
   * gigabyte of pnpm store to tens of megabytes.
   *
   * It matters here beyond image size: this is a pnpm workspace, so the real
   * `node_modules` is a forest of symlinks into a content-addressed store. A
   * naive `COPY node_modules` either follows them and duplicates everything or
   * copies the links and ships an image whose dependencies point at paths that
   * do not exist in it. Tracing sidesteps both.
   */
  output: "standalone",
  /**
   * The workspace root, not `apps/web` -- otherwise tracing stops at the app
   * boundary and leaves `@rescue/contracts` out of the bundle it just decided
   * the server needs.
   */
  outputFileTracingRoot: new URL("../..", import.meta.url).pathname
};

export default nextConfig;
