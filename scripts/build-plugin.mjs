import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputDirectory = resolve(repositoryRoot, "claude-plugin/server");

await mkdir(outputDirectory, { recursive: true });
await build({
  entryPoints: [
    resolve(repositoryRoot, "src/mcp/server.ts"),
    resolve(repositoryRoot, "src/mcp/hook-guard.ts"),
  ],
  outdir: outputDirectory,
  bundle: true,
  platform: "node",
  target: "node24",
  format: "esm",
  sourcemap: true,
  minify: false,
  legalComments: "none",
});

