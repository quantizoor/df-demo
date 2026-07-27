import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const projectRoot = resolve(appRoot, "../..");
const stateRoot = resolve(process.env.DF_DASHBOARD_STATE_ROOT ?? resolve(projectRoot, ".df/local"));
const dashboardRoot = resolve(stateRoot, "dashboard");
const tokenFile = resolve(dashboardRoot, "session-token");
const mode = process.argv[2] === "start" ? "start" : "dev";
const port = process.env.PORT ?? "3000";

await mkdir(dashboardRoot, { recursive: true, mode: 0o700 });
const token = randomBytes(32).toString("hex");
await writeFile(tokenFile, `${token}\n`, { encoding: "utf8", mode: 0o600 });
await chmod(tokenFile, 0o600);

const nextBin = resolve(appRoot, "node_modules/next/dist/bin/next");
const nextArguments = [nextBin, mode, "-H", "127.0.0.1", "-p", port];
if (mode === "dev") nextArguments.push("--webpack");
const child = spawn(process.execPath, nextArguments, {
  cwd: appRoot,
  env: {
    ...process.env,
    DF_DASHBOARD_ORIGIN: `http://127.0.0.1:${port}`,
    DF_DASHBOARD_PROJECT_ROOT: projectRoot,
    DF_DASHBOARD_STATE_ROOT: stateRoot,
    DF_DASHBOARD_TOKEN_FILE: tokenFile,
  },
  stdio: "inherit",
});

const consoleUrl = `http://127.0.0.1:${port}/campaigns`;
process.stdout.write(`\nDark Factory Console: ${consoleUrl}\n\n`);

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    if (child.exitCode === null) child.kill(signal);
  });
}

child.once("error", (error) => {
  process.stderr.write(`Unable to launch dashboard: ${error.message}\n`);
  process.exitCode = 1;
});
child.once("exit", (code, signal) => {
  if (signal !== null) process.kill(process.pid, signal);
  else process.exitCode = code ?? 1;
});
