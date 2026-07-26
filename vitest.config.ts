import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    testTimeout: 10_000,
    hookTimeout: 10_000,
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary", "lcov"],
      include: ["src/**/*.ts"],
      exclude: ["src/cli.ts"],
      thresholds: {
        lines: 90,
        branches: 90,
        functions: 90,
        statements: 90
      }
    }
  }
});

