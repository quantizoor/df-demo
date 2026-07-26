import { describe, expect, it } from "vitest";

import {
  inspectProductionOptimizeBindingReadiness,
  PRODUCTION_OPTIMIZE_BINDING_SPECIFICATIONS,
  type ProductionOptimizeExternalBinding,
  releaseSafeProductionOptimizeBindingReport,
} from "../../src/cloud/production-optimize-binding-readiness.js";
import { PRODUCTION_RUNTIME_PORT_IDS } from "../../src/orchestrator/production-runtime.js";

function sourceReadiness(status: "ready" | "missing" | "invalid" = "ready") {
  return {
    ready: status === "ready",
    missing: status === "missing" ? ["DF_PI_PRIVATE_VALUE"] : [],
    invalid: status === "invalid" ? ["DF_PI_PRIVATE_VALUE"] : [],
  };
}

function completeBindings(
  attestation = "a".repeat(64),
): Record<string, ProductionOptimizeExternalBinding> {
  const result: Record<string, ProductionOptimizeExternalBinding> = {};
  for (const specification of PRODUCTION_OPTIMIZE_BINDING_SPECIFICATIONS) {
    result[specification.bindingId] = {
      bindingId: specification.bindingId,
      boundary: "trusted-cloud",
      implementation: {
        privateValue: `never-release-${specification.bindingId}`,
      },
      attestationSha256: attestation,
    };
  }
  return result;
}

describe("production optimize binding readiness", () => {
  it("derives its nine executable slots from the runtime port contract", () => {
    expect(
      PRODUCTION_OPTIMIZE_BINDING_SPECIFICATIONS.slice(0, 2).map(
        (specification) => specification.bindingId,
      ),
    ).toEqual(["composition.manifest", "composition.attestation-verifier"]);
    expect(
      PRODUCTION_OPTIMIZE_BINDING_SPECIFICATIONS.slice(2).map(
        (specification) => specification.bindingId,
      ),
    ).toEqual(PRODUCTION_RUNTIME_PORT_IDS);
  });

  it("reports the exact stable missing surface without authorizing optimize", () => {
    const receipt = inspectProductionOptimizeBindingReadiness({
      bindings: {},
      piSourceConfiguration: sourceReadiness(),
    });

    expect(receipt.missingBindings).toEqual(
      PRODUCTION_OPTIMIZE_BINDING_SPECIFICATIONS.map((specification) => specification.bindingId),
    );
    expect(receipt.invalidBindings).toEqual([]);
    expect(receipt).toMatchObject({
      domain: "dark-factory.production-optimize-binding-readiness.v1",
      sourceConfigurationStatus: "ready",
      bindingsReady: false,
      runtimeCompositionVerified: false,
      runnable: false,
      registryMalformed: false,
      unexpectedBindingsPresent: false,
    });
    expect(receipt.bindingSetHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(receipt.bindingCommitmentHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(receipt.receiptHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(releaseSafeProductionOptimizeBindingReport(receipt).code).toBe(
      "DF_PRODUCTION_OPTIMIZE_BINDINGS_INCOMPLETE",
    );
  });

  it("keeps complete attested bindings non-runnable until composition verification", () => {
    const receipt = inspectProductionOptimizeBindingReadiness({
      bindings: completeBindings(),
      piSourceConfiguration: sourceReadiness(),
    });
    const report = releaseSafeProductionOptimizeBindingReport(receipt);

    expect(receipt).toMatchObject({
      bindingsReady: true,
      runtimeCompositionVerified: false,
      runnable: false,
      missingBindings: [],
      invalidBindings: [],
    });
    expect(report.code).toBe("DF_PRODUCTION_OPTIMIZE_COMPOSITION_UNVERIFIED");
    expect(report.runnable).toBe(false);
    expect(JSON.stringify({ receipt, report })).not.toContain("never-release");
  });

  it("fails closed on invalid and unexpected entries without reflecting arbitrary keys", () => {
    const bindings: Record<string, unknown> = completeBindings();
    bindings["optimizer.adapter"] = {
      bindingId: "optimizer.adapter",
      boundary: "trusted-cloud",
      implementation: {},
      attestationSha256: "not-a-digest",
    };
    bindings["hidden-task-name-never-release"] = {
      secret: "grader-output-never-release",
    };
    const receipt = inspectProductionOptimizeBindingReadiness({
      bindings,
      piSourceConfiguration: sourceReadiness(),
    });

    expect(receipt.invalidBindings).toEqual(["optimizer.adapter"]);
    expect(receipt.unexpectedBindingsPresent).toBe(true);
    expect(receipt.bindingsReady).toBe(false);
    const released = JSON.stringify(releaseSafeProductionOptimizeBindingReport(receipt));
    expect(released).not.toContain("hidden-task-name");
    expect(released).not.toContain("grader-output");
  });

  it("refuses to project a forged receipt containing an arbitrary binding identifier", () => {
    const receipt = inspectProductionOptimizeBindingReadiness({
      bindings: {},
      piSourceConfiguration: sourceReadiness(),
    });
    const forged = {
      ...receipt,
      missingBindings: ["hidden-task-name-never-release"],
    };

    expect(() =>
      releaseSafeProductionOptimizeBindingReport(forged as unknown as typeof receipt),
    ).toThrow("Production optimize binding readiness failed closed.");
  });

  it("summarizes source and registry failures without releasing environment names", () => {
    const malformed = inspectProductionOptimizeBindingReadiness({
      bindings: ["not", "a", "registry"],
      piSourceConfiguration: sourceReadiness("invalid"),
    });
    const missing = inspectProductionOptimizeBindingReadiness({
      piSourceConfiguration: sourceReadiness("missing"),
    });

    expect(malformed.registryMalformed).toBe(true);
    expect(malformed.sourceConfigurationStatus).toBe("invalid");
    expect(malformed.missingBindings).toHaveLength(
      PRODUCTION_OPTIMIZE_BINDING_SPECIFICATIONS.length,
    );
    expect(missing.registryMalformed).toBe(false);
    expect(missing.sourceConfigurationStatus).toBe("missing");
    expect(JSON.stringify({ malformed, missing })).not.toContain("DF_PI_PRIVATE_VALUE");
  });

  it("binds readiness hashes to attestation commitments, not implementation contents", () => {
    const firstBindings = completeBindings("b".repeat(64));
    const equivalentBindings = completeBindings("b".repeat(64));
    equivalentBindings["optimizer.adapter"] = {
      ...equivalentBindings["optimizer.adapter"]!,
      implementation: {
        anotherPrivateValue: "still-never-released",
      },
    };
    const changedBindings = completeBindings("b".repeat(64));
    changedBindings["optimizer.adapter"] = {
      ...changedBindings["optimizer.adapter"]!,
      attestationSha256: "c".repeat(64),
    };

    const first = inspectProductionOptimizeBindingReadiness({
      bindings: firstBindings,
      piSourceConfiguration: sourceReadiness(),
    });
    const equivalent = inspectProductionOptimizeBindingReadiness({
      bindings: equivalentBindings,
      piSourceConfiguration: sourceReadiness(),
    });
    const changed = inspectProductionOptimizeBindingReadiness({
      bindings: changedBindings,
      piSourceConfiguration: sourceReadiness(),
    });

    expect(equivalent.bindingCommitmentHash).toBe(first.bindingCommitmentHash);
    expect(equivalent.receiptHash).toBe(first.receiptHash);
    expect(changed.bindingCommitmentHash).not.toBe(first.bindingCommitmentHash);
    expect(changed.receiptHash).not.toBe(first.receiptHash);
  });
});
