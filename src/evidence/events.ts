import { lstat, readFile } from "node:fs/promises";

import type { EventRecord } from "../schemas/artifacts.js";
import { canonicalJson } from "../schemas/canonical.js";
import { assertValidDocument } from "../schemas/registry.js";

export interface EventChain {
  readonly records: readonly EventRecord[];
  readonly head: string | null;
}

export function parseAndVerifyEventChain(text: string): EventChain {
  if (text.length === 0) {
    return { records: [], head: null };
  }
  if (!text.endsWith("\n")) {
    throw new Error("events.jsonl is truncated: final newline is missing");
  }

  const records: EventRecord[] = [];
  let previousHash: string | null = null;
  const lines = text.slice(0, -1).split("\n");

  for (const [index, line] of lines.entries()) {
    if (line.length === 0) {
      throw new Error(`events.jsonl contains an empty record at sequence ${index}`);
    }

    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch (error) {
      throw new Error(`events.jsonl record ${index} is not valid JSON`, { cause: error });
    }
    assertValidDocument("eventRecord", value);
    if (line !== canonicalJson(value)) {
      throw new Error(`events.jsonl record ${index} is not canonical JSON`);
    }
    if (value.sequence !== index) {
      throw new Error(
        `events.jsonl sequence mismatch: expected ${index}, received ${value.sequence}`,
      );
    }
    if (value.previousEventHash !== previousHash) {
      throw new Error(`events.jsonl chain mismatch at sequence ${index}`);
    }

    records.push(value);
    previousHash = value.contentHash;
  }

  return { records, head: previousHash };
}

export async function readAndVerifyEventChain(path: string): Promise<EventChain> {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new Error("events.jsonl must be a regular file");
    }
    return parseAndVerifyEventChain(await readFile(path, "utf8"));
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return { records: [], head: null };
    }
    throw error;
  }
}
