import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 20000,
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      // thin executable shims; their logic lives in src/cli/main.ts and is tested there
      exclude: ["src/cli/bin.ts", "src/cli/speculate-mcp.ts"],
      reporter: ["text", "json-summary", "lcov"],
      thresholds: { lines: 85, statements: 85, functions: 85, branches: 75 },
    },
  },
});
