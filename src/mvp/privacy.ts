import {
  CAUSE_CODES,
  DIAGNOSTIC_CATEGORIES,
  INTERVENTION_CODES,
  type SanitizedDiagnosticBrief,
  TOOL_CLASSES,
  canonicalJson,
} from "./contracts.js";
import { validateMvpArtifact } from "./schemas.js";

/**
 * Fail-closed check for the intermediate sanitizer/LLM. The release is a
 * closed vocabulary: useful failure classes survive, arbitrary task text,
 * tool names, paths, grader messages, and per-task outcomes cannot.
 */
export function assertTaskFreeDiagnosticBrief(
  brief: SanitizedDiagnosticBrief,
  forbiddenLiterals: readonly string[],
): void {
  validateMvpArtifact("diagnostics", brief);
  const serialized = canonicalJson(brief);
  const lower = serialized.toLocaleLowerCase("en-US");
  for (const literal of forbiddenLiterals) {
    const normalized = literal.trim().toLocaleLowerCase("en-US");
    if (normalized.length >= 3 && lower.includes(normalized)) {
      throw new Error("Sanitized diagnostic brief contains a hidden source literal");
    }
  }
  const forbiddenShapes = [
    /\bhttps?:\/\//iu,
    /(?:^|[\s"'])\/(?:[a-z0-9._-]+\/)+[a-z0-9._-]+/iu,
    /\b[a-z]:\\(?:[^\\\s"]+\\)+[^\\\s"]+/iu,
    /\$[A-Z_][A-Z0-9_]*/u,
    /\b[A-Z][A-Z0-9]+_[A-Z0-9_]+\b/u,
    /\b[a-f0-9]{32,}\b/iu,
  ];
  if (forbiddenShapes.some((pattern) => pattern.test(serialized))) {
    throw new Error("Sanitized diagnostic brief contains a sensitive literal shape");
  }

  for (const card of brief.cards) {
    if (
      !DIAGNOSTIC_CATEGORIES.includes(card.category) ||
      !TOOL_CLASSES.includes(card.toolClass) ||
      !CAUSE_CODES.includes(card.cause) ||
      !INTERVENTION_CODES.includes(card.intervention)
    ) {
      throw new Error("Sanitized diagnostic brief escaped its closed vocabulary");
    }
  }
}
