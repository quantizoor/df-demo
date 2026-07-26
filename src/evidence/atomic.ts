import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, open, rename, unlink, type FileHandle } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

export interface AtomicWriteOptions {
  readonly overwrite?: boolean;
  readonly mode?: number;
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, constants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/**
 * Writes a complete durable temporary file, atomically installs it, and then
 * fsyncs the containing directory. The no-overwrite path uses a hard link so
 * an existing sealed artifact cannot be replaced by a rename race.
 */
export async function atomicWriteFile(
  targetPath: string,
  contents: string | Uint8Array,
  options: AtomicWriteOptions = {},
): Promise<void> {
  const directory = dirname(targetPath);
  const temporaryPath = join(
    directory,
    `.${basename(targetPath)}.${randomUUID().replaceAll("-", "")}.tmp`,
  );
  const handle = await open(temporaryPath, "wx", options.mode ?? 0o600);

  try {
    await handle.writeFile(contents);
    await handle.sync();
  } catch (error) {
    await handle.close().catch(() => undefined);
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
  await handle.close();

  try {
    if (options.overwrite === true) {
      await rename(temporaryPath, targetPath);
    } else {
      await link(temporaryPath, targetPath);
      await unlink(temporaryPath);
    }
    await syncDirectory(directory);
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

export async function durableAppendFile(targetPath: string, contents: string): Promise<void> {
  const handle = await open(targetPath, "a", 0o600);
  try {
    await handle.writeFile(contents);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await syncDirectory(dirname(targetPath));
}

export async function withExclusiveFileLock<T>(
  lockPath: string,
  operation: () => Promise<T>,
): Promise<T> {
  let handle: FileHandle;
  try {
    handle = await open(lockPath, "wx", 0o600);
  } catch (error) {
    throw new Error(`Evidence-store lock is already held: ${lockPath}`, { cause: error });
  }

  try {
    await handle.writeFile(`${process.pid}\n`);
    await handle.sync();
    return await operation();
  } finally {
    await handle.close().catch(() => undefined);
    await unlink(lockPath).catch(() => undefined);
    await syncDirectory(dirname(lockPath));
  }
}
