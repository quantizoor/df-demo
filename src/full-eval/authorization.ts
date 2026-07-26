import { randomBytes, timingSafeEqual } from "node:crypto";
import type {
  ChampionPointers,
  ComplianceManifest,
  ProtocolInputs,
} from "../domain/models.js";
import { assertComplianceManifest, isSubmissionEligibilityAllowed } from "../core/compliance.js";
import { DarkFactoryError } from "../core/errors.js";

export interface FullEvaluationReadiness {
  readonly manifest: ComplianceManifest;
  readonly protocol: ProtocolInputs;
  readonly protocolHash: string;
  readonly champions: ChampionPointers;
  readonly expectedTaskCount: 89;
  readonly trialsPerTask: 5;
  readonly expectedCostUsd: number;
}

export interface FullEvaluationChallenge {
  readonly challengeId: string;
  readonly challenge: string;
  readonly protocolHash: string;
  readonly expiresAt: string;
  readonly expectedTaskCount: 89;
  readonly trialsPerTask: 5;
  readonly expectedCostUsd: number;
}

export interface FullEvaluationAuthorization {
  readonly authorizationId: string;
  readonly challengeId: string;
  readonly protocolHash: string;
  readonly authorizedAt: string;
  readonly expiresAt: string;
  readonly usedAt: string | null;
}

export interface AuthorizationStore {
  putChallenge(challenge: FullEvaluationChallenge): Promise<void>;
  getChallenge(challengeId: string): Promise<FullEvaluationChallenge | null>;
  deleteChallenge(challengeId: string): Promise<void>;
  putAuthorization(authorization: FullEvaluationAuthorization): Promise<void>;
  getAuthorization(authorizationId: string): Promise<FullEvaluationAuthorization | null>;
  consumeAuthorization(authorizationId: string, usedAt: string): Promise<boolean>;
}

export interface HumanAuthorizationContext {
  readonly stdinIsTty: boolean;
  readonly source: "interactive-cli" | "ci" | "claude" | "mcp" | "background";
  readonly now: Date;
}

function opaqueToken(bytes = 24): string {
  return randomBytes(bytes).toString("base64url");
}

function equalSecret(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return (
    leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer)
  );
}

export function assertFullEvaluationReady(readiness: FullEvaluationReadiness): void {
  assertComplianceManifest(readiness.manifest);
  if (readiness.manifest.mode !== "submission") {
    throw new DarkFactoryError("FULL_EVAL_FORBIDDEN", "Full evaluation requires submission mode");
  }
  if (!isSubmissionEligibilityAllowed(readiness.manifest.leaderboardEligibility)) {
    throw new DarkFactoryError(
      "FULL_EVAL_FORBIDDEN",
      "Leaderboard eligibility has not been cleared",
    );
  }
  if (
    readiness.champions.certifiedCommit === null ||
    readiness.champions.certifiedExperiment === null ||
    readiness.champions.certifiedCommit !== readiness.champions.activeCommit
  ) {
    throw new DarkFactoryError(
      "FULL_EVAL_FORBIDDEN",
      "The active commit must be independently certified",
    );
  }
  if (
    readiness.protocolHash !== readiness.manifest.protocolHash ||
    readiness.protocol.mode !== "submission"
  ) {
    throw new DarkFactoryError(
      "PROTOCOL_MISMATCH",
      "Readiness records do not bind the same submission protocol",
    );
  }
}

export async function prepareFullEvaluation(
  store: AuthorizationStore,
  readiness: FullEvaluationReadiness,
  now: Date,
  ttlMs = 10 * 60 * 1000,
): Promise<FullEvaluationChallenge> {
  assertFullEvaluationReady(readiness);
  const challenge: FullEvaluationChallenge = {
    challengeId: opaqueToken(),
    challenge: opaqueToken(18),
    protocolHash: readiness.protocolHash,
    expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
    expectedTaskCount: 89,
    trialsPerTask: 5,
    expectedCostUsd: readiness.expectedCostUsd,
  };
  await store.putChallenge(challenge);
  return challenge;
}

export async function authorizeFullEvaluation(
  store: AuthorizationStore,
  challengeId: string,
  response: string,
  protocolHash: string,
  context: HumanAuthorizationContext,
  ttlMs = 5 * 60 * 1000,
): Promise<FullEvaluationAuthorization> {
  if (!context.stdinIsTty || context.source !== "interactive-cli") {
    throw new DarkFactoryError(
      "FULL_EVAL_FORBIDDEN",
      "Authorization requires a directly interactive human TTY",
      { source: context.source },
    );
  }
  const challenge = await store.getChallenge(challengeId);
  if (
    challenge === null ||
    new Date(challenge.expiresAt).getTime() <= context.now.getTime() ||
    challenge.protocolHash !== protocolHash ||
    !equalSecret(challenge.challenge, response)
  ) {
    throw new DarkFactoryError(
      "FULL_EVAL_FORBIDDEN",
      "Challenge is missing, expired, mismatched, or incorrect",
    );
  }

  const authorization: FullEvaluationAuthorization = {
    authorizationId: opaqueToken(),
    challengeId,
    protocolHash,
    authorizedAt: context.now.toISOString(),
    expiresAt: new Date(context.now.getTime() + ttlMs).toISOString(),
    usedAt: null,
  };
  await store.deleteChallenge(challengeId);
  await store.putAuthorization(authorization);
  return authorization;
}

export async function consumeFullEvaluationAuthorization(
  store: AuthorizationStore,
  authorizationId: string,
  protocolHash: string,
  context: HumanAuthorizationContext,
): Promise<void> {
  if (!context.stdinIsTty || context.source !== "interactive-cli") {
    throw new DarkFactoryError(
      "FULL_EVAL_FORBIDDEN",
      "Full evaluation may start only from an interactive human TTY",
    );
  }
  const authorization = await store.getAuthorization(authorizationId);
  if (
    authorization === null ||
    authorization.usedAt !== null ||
    authorization.protocolHash !== protocolHash ||
    new Date(authorization.expiresAt).getTime() <= context.now.getTime()
  ) {
    throw new DarkFactoryError(
      "FULL_EVAL_FORBIDDEN",
      "Authorization is missing, used, expired, or protocol-mismatched",
    );
  }
  if (!(await store.consumeAuthorization(authorizationId, context.now.toISOString()))) {
    throw new DarkFactoryError("FULL_EVAL_FORBIDDEN", "Authorization replay was rejected");
  }
}

