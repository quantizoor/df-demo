import { describe, expect, it } from "vitest";
import {
  computeTrustedHarborJobHash,
  createHarborInvocationSpec,
  createHarborOutputPackageSpec,
  hashHarborAgentIsolationPolicy,
  type TrustedHarborJobArtifact,
} from "../../src/terminal-bench/harbor.js";
import {
  serializeTrustedTerminalBenchInstruction,
  type TrustedTerminalBenchInstruction,
} from "../../src/terminal-bench/pi-agent.js";
import { hashTerminalBench21Pin, type TerminalBench21Pin } from "../../src/terminal-bench/pin.js";

const pin: TerminalBench21Pin = {
  benchmark: "terminal-bench-2.1",
  dataset: "terminal-bench/terminal-bench-2-1",
  registryRevision: 6,
  taskCount: 89,
  datasetContentSha256: "a".repeat(64),
  datasetManifestSha256: "b".repeat(64),
  harborVersion: "0.20.0",
  harborPackageSha256: "c".repeat(64),
  harborExecutableSha256: "d".repeat(64),
  piHarborAdapterSha256: "e".repeat(64),
};

function job(): TrustedHarborJobArtifact {
  const value: TrustedHarborJobArtifact = {
    sensitivity: "hidden-harbor-job",
    requestId: "request-001",
    stage: "validation",
    pinHash: hashTerminalBench21Pin(pin),
    isolationPolicyHash: hashHarborAgentIsolationPolicy(),
    jobSha256: "0".repeat(64),
    cellCount: 12,
    armCount: 24,
    uploads: [
      {
        role: "config-ab",
        artifact: {
          uri: "trusted://jobs/request-001/config-ab",
          sha256: "1".repeat(64),
          mediaType: "application/json",
          byteLength: 1024,
        },
        remotePath: "/trusted/jobs/config-ab.json",
      },
      {
        role: "config-ba",
        artifact: {
          uri: "trusted://jobs/request-001/config-ba",
          sha256: "2".repeat(64),
          mediaType: "application/json",
          byteLength: 1024,
        },
        remotePath: "/trusted/jobs/config-ba.json",
      },
      {
        role: "output-packager",
        artifact: {
          uri: "trusted://jobs/request-001/output-packager",
          sha256: "5".repeat(64),
          mediaType: "text/javascript",
          byteLength: 16_384,
        },
        remotePath: "/trusted/jobs/package-harbor-output.mjs",
      },
      {
        role: "pi-adapter",
        artifact: {
          uri: "trusted://jobs/request-001/adapter",
          sha256: pin.piHarborAdapterSha256,
          mediaType: "text/x-python",
          byteLength: 4096,
        },
        remotePath: "/trusted/jobs/dark_factory_pi.py",
      },
      {
        role: "candidate-runtime",
        artifact: {
          uri: "trusted://jobs/request-001/candidate",
          sha256: "3".repeat(64),
          mediaType: "application/gzip",
          byteLength: 65_536,
        },
        remotePath: "/trusted/jobs/candidate.tar.gz",
      },
      {
        role: "champion-runtime",
        artifact: {
          uri: "trusted://jobs/request-001/champion",
          sha256: "4".repeat(64),
          mediaType: "application/gzip",
          byteLength: 65_536,
        },
        remotePath: "/trusted/jobs/champion.tar.gz",
      },
    ],
    invocations: [
      {
        invocationId: "request-001-ab",
        order: "AB",
        configSha256: "1".repeat(64),
        remoteConfigPath: "/trusted/jobs/config-ab.json",
        remoteHarborJobPath: "/trusted/results/request-001-ab",
        remoteOutputPath: "/trusted/results/request-001-ab.harbor-output.tar",
        cellCount: 6,
        armCount: 12,
        agentOrder: ["candidate", "champion"],
        nAttempts: 1,
        nConcurrentTrials: 1,
        harborRetries: 0,
      },
      {
        invocationId: "request-001-ba",
        order: "BA",
        configSha256: "2".repeat(64),
        remoteConfigPath: "/trusted/jobs/config-ba.json",
        remoteHarborJobPath: "/trusted/results/request-001-ba",
        remoteOutputPath: "/trusted/results/request-001-ba.harbor-output.tar",
        cellCount: 6,
        armCount: 12,
        agentOrder: ["champion", "candidate"],
        nAttempts: 1,
        nConcurrentTrials: 1,
        harborRetries: 0,
      },
    ],
  };
  return { ...value, jobSha256: computeTrustedHarborJobHash(value) };
}

describe("Terminal-Bench 2.1 immutable pin", () => {
  it("accepts an exact dataset revision and content-addressed Harbor runtime", () => {
    expect(hashTerminalBench21Pin(pin)).toMatch(/^[a-f0-9]{64}$/u);
  });

  it.each([
    { registryRevision: 0 },
    { taskCount: 88 },
    { dataset: "terminal-bench/terminal-bench-2" },
    { harborVersion: "latest" },
    { harborVersion: "^0.3.2" },
    { datasetContentSha256: "mutable" },
  ])("fails closed on a mutable or wrong pin: %o", (change) => {
    expect(() =>
      hashTerminalBench21Pin({
        ...pin,
        ...change,
      } as TerminalBench21Pin),
    ).toThrow();
  });
});

describe("Harbor invocation boundary", () => {
  it("passes only a trusted config path, never hidden task selectors", () => {
    const command = createHarborInvocationSpec({
      harborExecutable: "/opt/harbor/bin/harbor",
      workingDirectory: "/workspace/evaluator",
      timeoutMs: 3_600_000,
      pin,
      job: job(),
      invocation: job().invocations[0]!,
      secretReferences: [
        {
          sourceEnvironmentName: "MODEL_API_KEY",
          targetEnvironmentName: "MODEL_API_KEY",
        },
      ],
    });
    expect(command.arguments).toEqual(["run", "-c", "/trusted/jobs/config-ab.json"]);
    expect(JSON.stringify(command)).not.toContain("include-task");
    expect(JSON.stringify(command)).not.toContain("taskId");
    expect(command.environment["DF_TERMINAL_BENCH_PIN_SHA256"]).toBe(hashTerminalBench21Pin(pin));
    expect(command.environment["DF_HARBOR_ISOLATION_POLICY_SHA256"]).toBe(
      hashHarborAgentIsolationPolicy(),
    );
    expect(command.environment["PYTHONPATH"]).toBe("/trusted/jobs");
  });

  it("rejects a job built for another benchmark pin", () => {
    expect(() =>
      createHarborInvocationSpec({
        harborExecutable: "/opt/harbor/bin/harbor",
        workingDirectory: "/workspace/evaluator",
        timeoutMs: 3_600_000,
        pin,
        job: { ...job(), pinHash: "0".repeat(64) },
        invocation: job().invocations[0]!,
        secretReferences: [],
      }),
    ).toThrow(/pin/u);
  });

  it("rejects a job that does not attest grader isolation", () => {
    expect(() =>
      createHarborInvocationSpec({
        harborExecutable: "/opt/harbor/bin/harbor",
        workingDirectory: "/workspace/evaluator",
        timeoutMs: 3_600_000,
        pin,
        job: { ...job(), isolationPolicyHash: "0".repeat(64) },
        invocation: job().invocations[0]!,
        secretReferences: [],
      }),
    ).toThrow(/isolation policy/u);
  });

  it("binds deterministic packaging to the Harbor execution without forwarding secrets", () => {
    const value = job();
    const command = createHarborOutputPackageSpec({
      nodeExecutable: "/usr/bin/node",
      workingDirectory: "/workspace/evaluator",
      timeoutMs: 900_000,
      pin,
      job: value,
      invocation: value.invocations[0]!,
      executionId: "execution-001",
    });
    expect(command.executable).toBe("/usr/bin/node");
    expect(command.arguments).toContain("/trusted/results/request-001-ab");
    expect(command.arguments).toContain("/trusted/results/request-001-ab.harbor-output.tar");
    expect(command.arguments).toContain("execution-001");
    expect(command.environment["DF_HARBOR_JOB_SHA256"]).toBe(value.jobSha256);
    expect(command.secretReferences).toEqual([]);
  });
});

describe("Harbor to Pi instruction boundary", () => {
  it("serializes only an explicitly grader-free Harbor task instruction", () => {
    const serialized = serializeTrustedTerminalBenchInstruction({
      sensitivity: "terminal-bench-instruction-trusted-only",
      source: "harbor-task-instruction",
      graderMaterialAttached: false,
      requestId: "prompt-001",
      instruction: "Complete the assigned terminal task.",
    });
    expect(serialized.endsWith("\n")).toBe(true);
    expect(JSON.parse(serialized)).toMatchObject({
      id: "prompt-001",
      type: "prompt",
    });
  });

  it("rejects a prompt contract that declares attached grader material", () => {
    expect(() =>
      serializeTrustedTerminalBenchInstruction({
        sensitivity: "terminal-bench-instruction-trusted-only",
        source: "harbor-task-instruction",
        graderMaterialAttached: true,
        requestId: "prompt-001",
        instruction: "forged",
      } as unknown as TrustedTerminalBenchInstruction),
    ).toThrow(/trusted boundary/u);
  });
});
