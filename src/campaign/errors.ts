export class CampaignControlError extends Error {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "CampaignControlError";
  }
}

export class CampaignNotInitializedError extends CampaignControlError {
  public constructor(campaignId: string) {
    super(`Campaign "${campaignId}" has no durable state`);
    this.name = "CampaignNotInitializedError";
  }
}

export class CampaignAlreadyInitializedError extends CampaignControlError {
  public constructor(campaignId: string) {
    super(`Campaign "${campaignId}" is already initialized`);
    this.name = "CampaignAlreadyInitializedError";
  }
}

export class CampaignConflictError extends CampaignControlError {
  public readonly expectedHash: string;
  public readonly actualHash: string;

  public constructor(expectedHash: string, actualHash: string) {
    super("Campaign state changed before the compare-and-swap update");
    this.name = "CampaignConflictError";
    this.expectedHash = expectedHash;
    this.actualHash = actualHash;
  }
}

export class CampaignIntegrityError extends CampaignControlError {
  public readonly violations: readonly string[];

  public constructor(message: string, violations: readonly string[], options?: ErrorOptions) {
    super(`${message}: ${violations.join("; ")}`, options);
    this.name = "CampaignIntegrityError";
    this.violations = violations;
  }
}

export class CampaignTransitionError extends CampaignControlError {
  public constructor(message: string) {
    super(message);
    this.name = "CampaignTransitionError";
  }
}

export class HarnessRegistrationError extends CampaignControlError {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "HarnessRegistrationError";
  }
}
