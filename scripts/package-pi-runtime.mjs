import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

const MAX_FILES = 100_000;
const MAX_BYTES = 4 * 1024 * 1024 * 1024;
const SHA256 = /^[a-f0-9]{64}$/u;
const OBJECT_ID = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u;
const VALUE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const PROVIDER_MARKERS = [
  "DAYTONA_SANDBOX_ID",
  "DAYTONA_WORKSPACE_ID",
  "E2B_SANDBOX_ID",
  "MODAL_TASK_ID",
];

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(78);
}

if (
  process.env.DF_CLOUD_EXECUTION !== "1" ||
  !PROVIDER_MARKERS.some((name) => Boolean(process.env[name]))
) {
  fail("Pi runtime packaging is permitted only in an attested cloud sandbox.");
}

function parseArguments(argv) {
  const allowed = new Set([
    "source-root",
    "output",
    "commit",
    "tree",
    "lock",
    "architecture",
    "build-policy-hash",
    "validation-level",
  ]);
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (typeof flag !== "string" || !flag.startsWith("--") || typeof value !== "string") {
      fail("Runtime packager arguments must be complete flag/value pairs.");
    }
    const name = flag.slice(2);
    if (!allowed.has(name) || values.has(name)) {
      fail("Runtime packager received an unsupported or duplicate flag.");
    }
    values.set(name, value);
  }
  if (values.size !== allowed.size) {
    fail("Runtime packager is missing a required immutable input.");
  }
  return Object.fromEntries(values);
}

function canonical(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail("Runtime manifest contains a non-finite number.");
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonical(entry)).join(",")}]`;
  }
  if (typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) {
    fail("Runtime manifest accepts only plain JSON values.");
  }
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
    .join(",")}}`;
}

async function sha256File(path) {
  const handle = await open(path, "r");
  const digest = createHash("sha256");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length);
      if (bytesRead === 0) break;
      digest.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    await handle.close();
  }
  return digest.digest("hex");
}

async function enumerateFiles(root) {
  const output = [];
  let totalBytes = 0;
  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const absolute = join(directory, entry.name);
      const metadata = await lstat(absolute);
      if (metadata.isSymbolicLink() || (!metadata.isDirectory() && !metadata.isFile())) {
        fail("Pi runtime output contains a link or special file.");
      }
      if (metadata.isDirectory()) {
        await visit(absolute);
        continue;
      }
      const path = relative(root, absolute).split(sep).join("/");
      if (
        path.length === 0 ||
        path.startsWith("../") ||
        path.includes("\u0000") ||
        output.length >= MAX_FILES
      ) {
        fail("Pi runtime output violates its file manifest policy.");
      }
      totalBytes += metadata.size;
      if (totalBytes > MAX_BYTES) fail("Pi runtime output exceeds its byte ceiling.");
      output.push({
        absolute,
        path,
        byteLength: metadata.size,
        executable: (metadata.mode & 0o111) !== 0,
        sha256: await sha256File(absolute),
      });
    }
  }
  await visit(root);
  return output;
}

const input = parseArguments(process.argv.slice(2));
if (
  !isAbsolute(input["source-root"]) ||
  !isAbsolute(input.output) ||
  input["source-root"].includes("\u0000") ||
  input.output.includes("\u0000") ||
  !OBJECT_ID.test(input.commit) ||
  !OBJECT_ID.test(input.tree) ||
  !SHA256.test(input.lock) ||
  !SHA256.test(input["build-policy-hash"]) ||
  input.architecture !== "x86_64" ||
  !new Set(["focused", "release"]).has(input["validation-level"])
) {
  fail("Runtime packager immutable inputs are malformed.");
}

const sourceRoot = await realpath(input["source-root"]);
const outputPath = resolve(input.output);
const outputParent = await realpath(dirname(outputPath));
if (
  outputPath === sourceRoot ||
  outputPath.startsWith(`${sourceRoot}${sep}`) ||
  !outputPath.startsWith(`${outputParent}${sep}`) ||
  !VALUE.test(basename(outputPath)) ||
  !outputPath.endsWith(".tar")
) {
  fail("Runtime archive output path is unsafe.");
}
try {
  await stat(outputPath);
  fail("Runtime archive output already exists.");
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
}

const distRoot = await realpath(join(sourceRoot, "packages", "coding-agent", "dist"));
if (!distRoot.startsWith(`${sourceRoot}${sep}`)) {
  fail("Pi build output escapes the candidate source root.");
}
const piEntrypoint = join(distRoot, "pi");
const piMetadata = await lstat(piEntrypoint);
if (!piMetadata.isFile() || piMetadata.isSymbolicLink() || (piMetadata.mode & 0o111) === 0) {
  fail("Pi build did not produce an executable compiled runtime.");
}

let packageMetadata;
try {
  packageMetadata = JSON.parse(
    await readFile(join(sourceRoot, "packages", "coding-agent", "package.json"), "utf8"),
  );
} catch {
  fail("Pi package metadata is unavailable after the build.");
}
if (
  packageMetadata?.name !== "@earendil-works/pi-coding-agent" ||
  typeof packageMetadata.version !== "string" ||
  !VALUE.test(packageMetadata.version)
) {
  fail("Pi package identity changed during candidate build.");
}

const stagingRoot = await mkdtemp(join(tmpdir(), "df-pi-runtime-"));
try {
  const runtimeDist = join(stagingRoot, "packages", "coding-agent", "dist");
  await mkdir(runtimeDist, { recursive: true, mode: 0o755 });
  const sourceFiles = await enumerateFiles(distRoot);
  for (const source of sourceFiles) {
    const target = join(runtimeDist, ...source.path.split("/"));
    await mkdir(dirname(target), { recursive: true, mode: 0o755 });
    await copyFile(source.absolute, target);
    await chmod(target, source.executable ? 0o755 : 0o644);
  }

  const copiedFiles = await enumerateFiles(stagingRoot);
  const manifest = {
    schemaVersion: 1,
    domain: "dark-factory.pi-runtime.v1",
    candidateCommit: input.commit,
    candidateTree: input.tree,
    lockSha256: input.lock,
    architecture: input.architecture,
    buildPolicyHash: input["build-policy-hash"],
    validationLevel: input["validation-level"],
    packageName: packageMetadata.name,
    packageVersion: packageMetadata.version,
    piEntrypoint: "packages/coding-agent/dist/pi",
    files: copiedFiles.map(({ path, byteLength, executable, sha256 }) => ({
      path,
      byteLength,
      executable,
      sha256,
    })),
  };
  const manifestJson = `${canonical(manifest)}\n`;
  await writeFile(join(stagingRoot, "runtime-manifest.json"), manifestJson, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o644,
  });

  const archive = spawnSync(
    "/usr/bin/tar",
    [
      "--sort=name",
      "--mtime=1970-01-01T00:00:00Z",
      "--owner=0",
      "--group=0",
      "--numeric-owner",
      "--format=posix",
      "--pax-option=delete=atime,delete=ctime",
      "--create",
      "--file",
      outputPath,
      "--directory",
      stagingRoot,
      "runtime-manifest.json",
      "packages",
    ],
    {
      encoding: "utf8",
      env: {
        LC_ALL: "C",
        PATH: "/usr/bin:/bin",
      },
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 5 * 60_000,
    },
  );
  if (
    archive.error ||
    archive.status !== 0 ||
    archive.signal !== null ||
    archive.stderr.length > 0
  ) {
    fail("Deterministic Pi runtime archiving failed.");
  }

  const outputMetadata = await lstat(outputPath);
  if (
    !outputMetadata.isFile() ||
    outputMetadata.isSymbolicLink() ||
    outputMetadata.size <= 0 ||
    outputMetadata.size > MAX_BYTES
  ) {
    fail("Pi runtime archive violates its output policy.");
  }
  process.stdout.write(
    `${canonical({
      kind: "pi-runtime-build-receipt",
      archiveSha256: await sha256File(outputPath),
      byteLength: outputMetadata.size,
      manifestSha256: createHash("sha256").update(manifestJson).digest("hex"),
      validationLevel: input["validation-level"],
      candidateCommit: input.commit,
      candidateTree: input.tree,
      buildPolicyHash: input["build-policy-hash"],
    })}\n`,
  );
} finally {
  await rm(stagingRoot, { recursive: true, force: true });
}
