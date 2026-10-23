import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@audiospan/manifest": r("./packages/manifest/src/index.ts"),
      "@audiospan/runtime": r("./packages/runtime/src/index.ts"),
      "@audiospan/sdk/testing": r("./packages/sdk/src/testing.ts"),
      "@audiospan/sdk": r("./packages/sdk/src/index.ts"),
      "@audiospan/ui": r("./packages/ui/src/index.ts"),
      "@audiospan/react": r("./packages/react/src/index.ts"),
      "@audiospan/cli": r("./packages/cli/src/lib.ts"),
    },
  },
  test: {
    include: ["packages/*/test/**/*.test.{ts,tsx}", "tests/abi/**/*.test.ts", "tests/security/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**", "tests/browser/**"],
    environment: "node",
    testTimeout: 20000,
  },
});
