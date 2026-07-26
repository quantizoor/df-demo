export class EvidenceStoreError extends Error {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "EvidenceStoreError";
  }
}

export class EvidenceIntegrityError extends EvidenceStoreError {
  public readonly findings: readonly string[];

  public constructor(message: string, findings: readonly string[]) {
    super(`${message}: ${findings.join("; ")}`);
    this.name = "EvidenceIntegrityError";
    this.findings = findings;
  }
}

export class SealedExperimentError extends EvidenceStoreError {
  public constructor(experimentName: string) {
    super(`Experiment "${experimentName}" is sealed; append an amendment instead`);
    this.name = "SealedExperimentError";
  }
}
