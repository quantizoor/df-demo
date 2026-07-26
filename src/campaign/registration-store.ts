import { lstat, mkdir, readdir, readFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

import { atomicWriteFile, withExclusiveFileLock } from "../evidence/atomic.js";
import { canonicalJson, withContentHash } from "../schemas/canonical.js";
import type { HarnessRegistration } from "../schemas/control.js";
import { assertValidDocument } from "../schemas/registry.js";
import { HarnessRegistrationError } from "./errors.js";

const SAFE_IDENTIFIER = /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/u;

export type HarnessRegistrationDraft = Omit<HarnessRegistration, "contentHash">;

export interface HarnessRegistrationVerifier {
  readonly verify: (registration: HarnessRegistration) => Promise<void>;
}

export interface HarnessRegistrationStoreOptions {
  readonly verifier?: HarnessRegistrationVerifier;
}

function isMissingFile(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function assertSafeIdentifier(value: string): void {
  if (value.length > 96 || !SAFE_IDENTIFIER.test(value)) {
    throw new HarnessRegistrationError(`Invalid harness registration id "${value}"`);
  }
}

async function assertRegularDirectory(path: string, label: string): Promise<void> {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new HarnessRegistrationError(`${label} must be a regular directory`);
  }
}

async function readCanonicalRegistration(path: string): Promise<HarnessRegistration> {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new HarnessRegistrationError(`${basename(path)} must be a regular file`);
  }
  const contents = await readFile(path, "utf8");
  let value: unknown;
  try {
    value = JSON.parse(contents);
  } catch (error) {
    throw new HarnessRegistrationError(`${basename(path)} is not valid JSON`, {
      cause: error,
    });
  }
  if (contents !== `${canonicalJson(value)}\n`) {
    throw new HarnessRegistrationError(
      `${basename(path)} is not canonical JSON followed by one newline`,
    );
  }
  assertValidDocument("harnessRegistration", value);
  return value;
}

export function createHarnessRegistration(draft: HarnessRegistrationDraft): HarnessRegistration {
  const value: unknown = withContentHash(draft);
  assertValidDocument("harnessRegistration", value);
  return value;
}

/**
 * Immutable registry for credential-free harness identities.
 */
export class HarnessRegistrationStore {
  readonly #root: string;
  readonly #verifier: HarnessRegistrationVerifier | undefined;

  public constructor(root: string, options: HarnessRegistrationStoreOptions = {}) {
    this.#root = resolve(root);
    this.#verifier = options.verifier;
  }

  public get root(): string {
    return this.#root;
  }

  public async initialize(): Promise<void> {
    await mkdir(this.#root, { recursive: true, mode: 0o700 });
    await assertRegularDirectory(this.#root, "Harness registration root");
  }

  public async register(registration: HarnessRegistration): Promise<void> {
    const registrationSnapshot = JSON.parse(canonicalJson(registration)) as HarnessRegistration;
    assertValidDocument("harnessRegistration", registrationSnapshot);
    await this.#verify(registrationSnapshot);
    assertSafeIdentifier(registrationSnapshot.registrationId);
    await this.initialize();
    const lockPath = join(this.#root, `.${registrationSnapshot.registrationId}.lock`);
    await withExclusiveFileLock(lockPath, async () => {
      const path = this.#path(registrationSnapshot.registrationId);
      try {
        const existing = await readCanonicalRegistration(path);
        if (existing.contentHash === registrationSnapshot.contentHash) {
          return;
        }
        throw new HarnessRegistrationError(
          `Harness registration "${registrationSnapshot.registrationId}" ` +
            "already exists with different content",
        );
      } catch (error) {
        if (!isMissingFile(error)) {
          throw error;
        }
      }
      await atomicWriteFile(path, `${canonicalJson(registrationSnapshot)}\n`);
    });
  }

  public async read(registrationId: string): Promise<HarnessRegistration> {
    assertSafeIdentifier(registrationId);
    await this.initialize();
    const registration = await readCanonicalRegistration(this.#path(registrationId));
    if (registration.registrationId !== registrationId) {
      throw new HarnessRegistrationError(
        `Registration id "${registration.registrationId}" does not match its file name`,
      );
    }
    await this.#verify(registration);
    return registration;
  }

  public async list(): Promise<readonly HarnessRegistration[]> {
    await this.initialize();
    const entries = await readdir(this.#root, { withFileTypes: true });
    const names = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => entry.name.slice(0, -".json".length))
      .sort();
    const registrations: HarnessRegistration[] = [];
    for (const name of names) {
      registrations.push(await this.read(name));
    }
    return registrations;
  }

  #path(registrationId: string): string {
    return join(this.#root, `${registrationId}.json`);
  }

  async #verify(registration: HarnessRegistration): Promise<void> {
    if (this.#verifier === undefined) {
      throw new HarnessRegistrationError("A trusted harness-registration verifier is required");
    }
    await this.#verifier.verify(JSON.parse(canonicalJson(registration)) as HarnessRegistration);
  }
}
