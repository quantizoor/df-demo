import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    env: {
      TMPDIR: realpathSync(tmpdir()),
    },
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
        lines: 78,
        branches: 74,
        functions: 89,
        statements: 77,
      },
    },
  },
});
