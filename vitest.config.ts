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
      // These files are executable cloud/process boundaries whose meaningful
      // behavior depends on Daytona, Harbor, real OS identities, and protected
      // secret placeholders. Deterministic cores and injected-port contracts
      // remain under the 90% gate; these boundaries are mandatory synthetic
      // and connectivity-smoke targets before the first paid iteration.
      exclude: [
        "src/cli.ts",
        "src/mvp/cloud-cli.ts",
        "src/mvp/cloud-controller.ts",
        "src/mvp/cloud-evaluator-worker.ts",
        "src/mvp/cloud-optimizer-worker.ts",
        "src/mvp/evaluator-runtime.ts",
        "src/mvp/evaluator-runtime-node.ts",
      ],
      thresholds: {
        lines: 90,
        branches: 90,
        functions: 90,
        statements: 90
      }
    }
  }
});
