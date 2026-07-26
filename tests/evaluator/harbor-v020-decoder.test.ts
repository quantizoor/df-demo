import { describe, expect, it } from "vitest";

import { canonicalJson } from "../../src/schemas/canonical.js";
import {
  HARBOR_0_20_0_VERSION,
  HARBOR_0_20_0_WHEEL_SHA256,
  StrictHarbor020RawArtifactDecoder,
  hashTrustedHarbor020DecodingPlan,
  type TrustedHarbor020DecodingPlan,
} from "../../src/evaluator/harbor-v020-decoder.js";
import type { HiddenTaskId } from "../../src/evaluation/types.js";

const digest = (value: string): string => value.repeat(64).slice(0, 64);
const REQUEST_ID = "request-1";
const JOB_SHA256 = digest("1");
const SOURCE_SHA256 = digest("2");
const RUNTIME_SHA256 = digest("3");
const MANIFEST_SHA256 = digest("4");
const SET_SHA256 = digest("5");
const INPUT_SHA256 = digest("6");
const TASK_ID = digest("7") as HiddenTaskId;
const TASK_REVISION = digest("8");
const HARNESS_SHA256 = digest("9");
const TASK_CHECKSUM = digest("a");
const PROTOCOL_SHA256 = digest("b");
const ENVIRONMENT_SHA256 = digest("c");
const TRIAL_ID = "123e4567-e89b-42d3-a456-426614174000";
const JOB_ID = "123e4567-e89b-42d3-a456-426614174001";
const ARM_ID = "request-1-cell-01-candidate";
const TASK_NAME = "terminal-bench/hard-task";

function plan(): TrustedHarbor020DecodingPlan {
  const unsigned = {
    sensitivity: "trusted-harbor-0.20.0-decoding-plan" as const,
    schemaVersion: 1 as const,
    requestId: REQUEST_ID,
    jobSha256: JOB_SHA256,
    sourceEvidenceHash: SOURCE_SHA256,
    protocolHash: PROTOCOL_SHA256,
    environmentFingerprintHash: ENVIRONMENT_SHA256,
    evaluatedModel: {
      provider: "microsoft-foundry",
      modelId: "df-opus48-eval",
    },
    invocations: [
      {
        invocationId: "request-1-repair",
        order: "repair" as const,
        configSha256: digest("d"),
        executionId: "execution-1",
        arms: [
          {
            scheduleArmId: ARM_ID,
            taskId: TASK_ID,
            taskRevisionDigest: TASK_REVISION,
            capabilityStratum: "shell",
            arm: "candidate" as const,
            order: "AB" as const,
            harnessArchiveSha256: HARNESS_SHA256,
            harborTaskName: TASK_NAME,
            harborTaskChecksum: TASK_CHECKSUM,
          },
        ],
      },
    ],
  };
  return {
    ...unsigned,
    planHash: hashTrustedHarbor020DecodingPlan(unsigned),
  };
}

function header(schemaVersion: string) {
  return {
    schemaVersion,
    harborVersion: HARBOR_0_20_0_VERSION,
    harborWheelSha256: HARBOR_0_20_0_WHEEL_SHA256,
    requestId: REQUEST_ID,
    jobSha256: JOB_SHA256,
    sourceEvidenceHash: SOURCE_SHA256,
  };
}

function timing(startedAt = "2026-01-01T00:00:01.000000") {
  return {
    started_at: startedAt,
    finished_at: "2026-01-01T00:00:02.000000",
  };
}

function trialResult() {
  return {
    id: TRIAL_ID,
    task_name: TASK_NAME,
    trial_name: "hard-task__abc1234",
    trial_uri: "file:///trusted/jobs/hard-task__abc1234",
    task_id: {
      org: "terminal-bench",
      name: "hard-task",
      ref: "2",
    },
    source: "terminal-bench",
    task_checksum: TASK_CHECKSUM,
    config: {
      task: {
        path: null,
        git_url: null,
        git_commit_id: null,
        name: TASK_NAME,
        ref: "2",
        overwrite: false,
        download_dir: null,
        source: "terminal-bench",
      },
      trial_name: "hard-task__abc1234",
      job_id: JOB_ID,
      source_trial: null,
      agent: {
        name: "dark-factory-candidate",
        import_path: "dark_factory_pi:DarkFactoryPi",
        model_name: "microsoft-foundry/df-opus48-eval",
        resume_trajectory: false,
        load_trajectory: null,
        skills: [],
        mcp_servers: [],
        extra_allowed_hosts: [
          "df-eu-prod.services.ai.azure.com",
        ],
        kwargs: {
          runtime_archive_path: "/trusted/candidate.tar",
          runtime_sha256: HARNESS_SHA256,
          pi_entrypoint: "bin/pi",
          thinking: "high",
          enabled_tools: ["read", "bash"],
          credential_environment_names: [
            "ANTHROPIC_FOUNDRY_API_KEY",
          ],
          foundry_resource_name: "df-eu-prod",
          model_family: "claude-opus-4-8",
        },
      },
    },
    agent_info: {
      name: "dark-factory-pi",
      version: "1.2.3",
      model_info: {
        name: "df-opus48-eval",
        provider: "microsoft-foundry",
      },
    },
    agent_result: {
      n_input_tokens: 10,
      n_cache_tokens: 2,
      n_output_tokens: 4,
      cost_usd: 0.01,
      rollout_details: null,
      metadata: null,
    },
    verifier_result: {
      rewards: {
        reward: 1,
      },
    },
    verifier_environment_mode: "separate",
    exception_info: null,
    started_at: "2026-01-01T00:00:00.000000",
    finished_at: "2026-01-01T00:00:03.000000",
    environment_setup: timing("2026-01-01T00:00:00.000000"),
    agent_setup: timing("2026-01-01T00:00:00.000000"),
    agent_execution: timing(),
    verifier: timing("2026-01-01T00:00:02.000000"),
    step_results: null,
  };
}

function documents() {
  const harbor = {
    ...header("dark-factory.harbor-0.20.0-results.v1"),
    invocations: [
      {
        invocationId: "request-1-repair",
        order: "repair",
        configSha256: digest("d"),
        executionId: "execution-1",
        jobResult: {
          id: JOB_ID,
          started_at: "2026-01-01T00:00:00.000000",
          updated_at: "2026-01-01T00:00:03.000000",
          finished_at: "2026-01-01T00:00:03.000000",
          n_total_trials: 1,
          stats: {
            n_completed_trials: 1,
            n_errored_trials: 0,
            n_running_trials: 0,
            n_pending_trials: 0,
            n_cancelled_trials: 0,
            n_retries: 0,
            evals: {},
            n_input_tokens: 10,
            n_cache_tokens: 2,
            n_output_tokens: 4,
            cost_usd: 0.01,
          },
        },
        trials: [
          {
            scheduleArmId: ARM_ID,
            attemptOrdinal: 1,
            result: trialResult(),
          },
        ],
      },
    ],
  };
  const grader = {
    ...header("dark-factory.harbor-0.20.0-graders.v1"),
    records: [
      {
        trialId: TRIAL_ID,
        scheduleArmId: ARM_ID,
        attemptOrdinal: 1,
        passed: true,
        boundedReward: 1,
        infrastructureInvalidClass: null,
        integrityStatus: "passed",
        elapsedMs: 1_000,
        cpuUtilizationPercent: null,
        maxRssMb: null,
        protocolHash: PROTOCOL_SHA256,
        environmentFingerprintHash: ENVIRONMENT_SHA256,
        sandboxUsd: 0.02,
      },
    ],
  };
  const atif = {
    ...header("dark-factory.harbor-0.20.0-atif.v1"),
    records: [
      {
        trialId: TRIAL_ID,
        scheduleArmId: ARM_ID,
        attemptOrdinal: 1,
        trajectory: {
          schema_version: "ATIF-v1.7",
          session_id: "pi-run-1234567890abcdef1234567890abcdef",
          trajectory_id: `pi-trajectory-${digest("e")}`,
          agent: {
            name: "dark-factory-pi",
            version: HARNESS_SHA256,
            model_name: "microsoft-foundry/df-opus48-eval",
            extra: {
              runtime_sha256: HARNESS_SHA256,
            },
          },
          steps: [
            {
              step_id: 1,
              timestamp: "2026-01-01T00:00:01.000Z",
              source: "user",
              message: "secret benchmark instruction",
            },
            {
              step_id: 2,
              timestamp: "2026-01-01T00:00:02.000Z",
              source: "agent",
              model_name: "df-opus48-eval",
              reasoning_effort: "high",
              message: "secret task-specific answer",
              metrics: {
                prompt_tokens: 10,
                completion_tokens: 4,
                cached_tokens: 2,
                cost_usd: 0.01,
              },
              llm_call_count: 1,
            },
          ],
          final_metrics: {
            total_prompt_tokens: 10,
            total_completion_tokens: 4,
            total_cached_tokens: 2,
            total_cost_usd: 0.01,
            total_steps: 2,
          },
          extra: {
            dark_factory: {
              compaction_count: 0,
              retry_count: 0,
              bash_update_count: 0,
              agent_settled: true,
            },
          },
        },
      },
    ],
  };
  return { harbor, grader, atif };
}

function bytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(canonicalJson(value));
}

function decoder() {
  const sealedPlan = plan();
  return new StrictHarbor020RawArtifactDecoder({
    deployment: "test-only",
    plans: {
      boundary: "test-only-in-memory",
      async load() {
        return sealedPlan;
      },
    },
  });
}

async function decode(
  mutate?: (documents: ReturnType<typeof documents>) => void,
) {
  const docs = documents();
  mutate?.(docs);
  return decoder().decode({
    requestId: REQUEST_ID,
    jobSha256: JOB_SHA256,
    runtimeAttestationHash: RUNTIME_SHA256,
    sourceEvidenceHash: SOURCE_SHA256,
    rawManifestHash: MANIFEST_SHA256,
    rawArtifactSetHash: SET_SHA256,
    plaintexts: {
      atif: bytes(docs.atif),
      "grader-output": bytes(docs.grader),
      "harbor-output": bytes(docs.harbor),
    },
    inputBindingHash: INPUT_SHA256,
  });
}

describe("StrictHarbor020RawArtifactDecoder", () => {
  it("emits only opaque task identity, scalar outcomes, and generic behavior", async () => {
    const result = await decode();

    expect(result.inputBindingHash).toBe(INPUT_SHA256);
    expect(result.decoded.attempts).toHaveLength(1);
    expect(result.decoded.attempts[0]?.taskId).toBe(TASK_ID);
    expect(result.decoded.attempts[0]?.grader.passed).toBe(true);
    const releasedShape = JSON.stringify(result.decoded);
    expect(releasedShape).not.toContain(TASK_NAME);
    expect(releasedShape).not.toContain("secret benchmark instruction");
    expect(releasedShape).not.toContain("secret task-specific answer");
  });

  it("rejects an unknown grader prose field", async () => {
    await expect(
      decode((docs) => {
        Object.assign(docs.grader.records[0]!, {
          explanation: "the hidden assertion failed",
        });
      }),
    ).rejects.toThrow();
  });

  it("rejects a trial mapped to another hidden task", async () => {
    await expect(
      decode((docs) => {
        docs.harbor.invocations[0]!.trials[0]!.result.task_name =
          "terminal-bench/another-task";
      }),
    ).rejects.toThrow();
  });

  it("rejects a Foundry endpoint not derived from the sealed resource", async () => {
    await expect(
      decode((docs) => {
        docs.harbor.invocations[0]!.trials[0]!.result.config.agent
          .extra_allowed_hosts = ["api.anthropic.com"];
      }),
    ).rejects.toThrow();
  });

  it("rejects task-specific metadata smuggled through ATIF extra", async () => {
    await expect(
      decode((docs) => {
        Object.assign(docs.atif.records[0]!.trajectory.extra.dark_factory, {
          task_name: TASK_NAME,
        });
      }),
    ).rejects.toThrow();
  });

  it("rejects omitted matched arms", async () => {
    await expect(
      decode((docs) => {
        docs.grader.records.length = 0;
      }),
    ).rejects.toThrow();
  });

  it("rejects noncanonical JSON before schema decoding", async () => {
    const docs = documents();
    const canonicalAtif = canonicalJson(docs.atif);
    await expect(
      decoder().decode({
        requestId: REQUEST_ID,
        jobSha256: JOB_SHA256,
        runtimeAttestationHash: RUNTIME_SHA256,
        sourceEvidenceHash: SOURCE_SHA256,
        rawManifestHash: MANIFEST_SHA256,
        rawArtifactSetHash: SET_SHA256,
        plaintexts: {
          atif: new TextEncoder().encode(`${canonicalAtif}\n`),
          "grader-output": bytes(docs.grader),
          "harbor-output": bytes(docs.harbor),
        },
        inputBindingHash: INPUT_SHA256,
      }),
    ).rejects.toThrow();
  });
});
