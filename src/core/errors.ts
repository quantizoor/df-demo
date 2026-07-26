export type DarkFactoryErrorCode =
  | "BUDGET_EXHAUSTED"
  | "CLOUD_REQUIRED"
  | "CONFIG_INVALID"
  | "EVIDENCE_INVALID"
  | "FULL_EVAL_FORBIDDEN"
  | "HARNESS_INVALID"
  | "INTEGRITY_VIOLATION"
  | "INVALID_TRANSITION"
  | "PROTOCOL_MISMATCH"
  | "STORE_CORRUPT"
  | "USER_INPUT_REQUIRED";

export class DarkFactoryError extends Error {
  public readonly code: DarkFactoryErrorCode;
  public readonly details: Readonly<Record<string, unknown>>;

  public constructor(
    code: DarkFactoryErrorCode,
    message: string,
    details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = "DarkFactoryError";
    this.code = code;
    this.details = details;
  }
}

export function asErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
