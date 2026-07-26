import { randomUUID } from "node:crypto";
import { mkdir, open, rename, rm } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";

export const MVP_MAX_STATE_BYTES = 8 * 1024 * 1024;

export function assertMountedRoot(root: string): void {
  if (!isAbsolute(root) || root === "/") {
    throw new Error("Trusted MVP storage root must be an explicit absolute path");
  }
}

export async function readBoundedJson(
  path: string,
  maximumBytes = MVP_MAX_STATE_BYTES,
): Promise<unknown> {
  const handle = await open(path, "r");
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size < 2 || stat.size > maximumBytes) {
      throw new Error("Trusted MVP JSON file has an invalid size or type");
    }
    return JSON.parse(await handle.readFile({ encoding: "utf8" })) as unknown;
  } finally {
    await handle.close();
  }
}

export async function readOptionalBoundedJson(
  path: string,
  maximumBytes = MVP_MAX_STATE_BYTES,
): Promise<unknown | null> {
  try {
    return await readBoundedJson(path, maximumBytes);
  } catch (error) {
    if (isNodeError(error, "ENOENT")) {
      return null;
    }
    throw error;
  }
}

export async function writeJsonAtomic(path: string, value: unknown, mode = 0o600): Promise<void> {
  const parent = dirname(path);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const temporaryPath = join(parent, `.tmp-${randomUUID()}.json`);
  try {
    const handle = await open(temporaryPath, "wx", mode);
    try {
      await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporaryPath, path);
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
}

export async function withMountedLock<Result>(
  root: string,
  name: string,
  operation: () => Promise<Result>,
): Promise<Result> {
  assertMountedRoot(root);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const lockDirectory = join(root, `.${name}.lock`);
  try {
    await mkdir(lockDirectory, { mode: 0o700 });
  } catch (error) {
    if (isNodeError(error, "EEXIST")) {
      throw new Error(`Trusted MVP ${name} is locked by another writer`);
    }
    throw error;
  }
  try {
    return await operation();
  } finally {
    await rm(lockDirectory, { recursive: true, force: true });
  }
}

export function isNodeError(error: unknown, code: string): boolean {
  return (
    error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === code
  );
}
