export const MVP_PREFLIGHT_DIAGNOSTIC_CODES = [
  "unknown",
  "outer-configuration",
  "outer-create",
  "outer-stage",
  "outer-stage-upload",
  "outer-stage-digest",
  "outer-stage-install-root",
  "outer-stage-extraction",
  "outer-stage-root-authority",
  "outer-stage-adapter-ownership",
  "outer-execute",
  "outer-cleanup",
  "worker-boundary",
  "worker-configuration",
  "worker-output-invalid",
  "bootstrap-input",
  "bootstrap-artifacts-pins",
  "bootstrap-artifacts-harbor",
  "bootstrap-artifacts-bun",
  "bootstrap-artifacts-adapter",
  "bootstrap-lock",
  "bootstrap-state",
  "bootstrap-discovery-arguments",
  "bootstrap-discovery-runtime",
  "bootstrap-discovery-registry",
  "bootstrap-discovery-download",
  "bootstrap-discovery-inventory",
  "bootstrap-discovery-eligibility",
  "bootstrap-discovery-compatibility",
  "bootstrap-discovery-compatibility-create",
  "bootstrap-discovery-compatibility-runtime",
  "bootstrap-discovery-compatibility-mixed",
  "bootstrap-discovery-compatibility-cleanup",
  "bootstrap-discovery-download-cleanup",
  "bootstrap-discovery-output",
  "bootstrap-discovery-unknown",
  "bootstrap-validation",
  "bootstrap-persistence",
  "synthetic-runtime",
  "connectivity-unimplemented",
] as const;

export type MvpPreflightDiagnosticCode = (typeof MVP_PREFLIGHT_DIAGNOSTIC_CODES)[number];

export const MVP_OUTER_STAGE_FAILURE_PHASES = [
  "upload",
  "digest",
  "install-root",
  "extraction",
  "root-authority",
  "adapter-ownership",
] as const;

export type MvpOuterStageFailurePhase = (typeof MVP_OUTER_STAGE_FAILURE_PHASES)[number];

export const MVP_DISCOVERY_FAILURE_PHASES = [
  "arguments",
  "runtime",
  "registry",
  "download",
  "inventory",
  "eligibility",
  "compatibility",
  "compatibility-create",
  "compatibility-runtime",
  "compatibility-mixed",
  "compatibility-cleanup",
  "download-cleanup",
  "output",
  "unknown",
] as const;

export type MvpDiscoveryFailurePhase = (typeof MVP_DISCOVERY_FAILURE_PHASES)[number];

const diagnosticCodes = new Set<string>(MVP_PREFLIGHT_DIAGNOSTIC_CODES);
const outerStageFailurePhases = new Set<string>(MVP_OUTER_STAGE_FAILURE_PHASES);
const discoveryFailurePhases = new Set<string>(MVP_DISCOVERY_FAILURE_PHASES);
const WORKER_FAILURE_PREFIX = "MVP_PREFLIGHT_FAILURE:";
const CLI_FAILURE_PREFIX = "MVP_PREFLIGHT_FAILED_CLOSED:";
const DISCOVERY_FAILURE_PREFIX = "MVP_DISCOVERY_FAILURE:";

export class MvpPreflightDiagnosticError extends Error {
  override readonly name = "MvpPreflightDiagnosticError";

  public constructor(readonly code: MvpPreflightDiagnosticCode) {
    super(`The protected MVP preflight failed closed (${code}).`);
  }
}

export function isMvpPreflightDiagnosticCode(value: unknown): value is MvpPreflightDiagnosticCode {
  return typeof value === "string" && diagnosticCodes.has(value);
}

export function asMvpPreflightDiagnosticError(
  error: unknown,
  fallback: MvpPreflightDiagnosticCode,
): MvpPreflightDiagnosticError {
  return error instanceof MvpPreflightDiagnosticError
    ? error
    : new MvpPreflightDiagnosticError(fallback);
}

export function formatMvpPreflightWorkerFailure(code: unknown): string {
  return `${WORKER_FAILURE_PREFIX}${isMvpPreflightDiagnosticCode(code) ? code : "unknown"}\n`;
}

export function parseMvpPreflightWorkerFailure(raw: string): MvpPreflightDiagnosticCode | null {
  if (!raw.endsWith("\n") || raw.indexOf("\n") !== raw.length - 1) return null;
  const code = raw.slice(WORKER_FAILURE_PREFIX.length, -1);
  return raw.startsWith(WORKER_FAILURE_PREFIX) && isMvpPreflightDiagnosticCode(code) ? code : null;
}

export function formatMvpPreflightCliFailure(code: unknown): string {
  return `${CLI_FAILURE_PREFIX}${isMvpPreflightDiagnosticCode(code) ? code : "unknown"}\n`;
}

export function outerStagePhaseDiagnosticCode(
  phase: MvpOuterStageFailurePhase,
): MvpPreflightDiagnosticCode {
  if (!outerStageFailurePhases.has(phase)) return "outer-stage";
  return `outer-stage-${phase}`;
}

export function parseMvpDiscoveryFailurePhase(raw: string): MvpDiscoveryFailurePhase | null {
  const finalLine = raw.endsWith("\n")
    ? raw.slice(0, -1).slice(raw.slice(0, -1).lastIndexOf("\n") + 1)
    : raw.slice(raw.lastIndexOf("\n") + 1);
  if (!finalLine.startsWith(DISCOVERY_FAILURE_PREFIX)) return null;
  const phase = finalLine.slice(DISCOVERY_FAILURE_PREFIX.length);
  return discoveryFailurePhases.has(phase) ? (phase as MvpDiscoveryFailurePhase) : null;
}

export function discoveryPhaseDiagnosticCode(
  phase: MvpDiscoveryFailurePhase,
): MvpPreflightDiagnosticCode {
  return `bootstrap-discovery-${phase}`;
}
