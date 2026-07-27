import { copyFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputDirectory = resolve(repositoryRoot, "claude-plugin/server");
const runtimeAssets = [
  [
    resolve(repositoryRoot, "src/local/assets/dark_factory_pi_local.py"),
    resolve(repositoryRoot, "dist/local/assets/dark_factory_pi_local.py"),
  ],
  [
    resolve(repositoryRoot, "src/terminal-bench/assets/dark_factory_pi.py"),
    resolve(repositoryRoot, "dist/terminal-bench/assets/dark_factory_pi.py"),
  ],
];

await mkdir(outputDirectory, { recursive: true });
for (const [source, destination] of runtimeAssets) {
  await mkdir(dirname(destination), { recursive: true });
  await copyFile(source, destination);
}
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
