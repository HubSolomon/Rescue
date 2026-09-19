import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

/**
 * No @vitejs/plugin-react here on purpose: it pulls in a second major of vite
 * whose plugin types clash with vitest's, and its only real benefit is Fast
 * Refresh, which tests do not use. esbuild's automatic JSX runtime is enough.
 */
export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./", import.meta.url)) }
  },
  // The app's tsconfig sets jsx: "preserve" for Next, so vitest needs the
  // automatic runtime spelled out or every .tsx test fails on "React is not
  // defined".
  esbuild: { jsx: "automatic", jsxImportSource: "react" },
  test: {
    environment: "jsdom",
    globals: false,
    setupFiles: ["./vitest.setup.ts"],
    // Playwright specs live in e2e/ and are run by Playwright, not vitest.
    include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"]
  }
});
