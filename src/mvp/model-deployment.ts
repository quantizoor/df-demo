/**
 * Conservative alias grammar shared by every MVP Foundry boundary.
 *
 * A deployment alias is 1-128 lowercase ASCII characters, expressed as
 * alphanumeric segments separated by a single ".", "_", or "-". Provider
 * names and model IDs are separate fields, so aliases containing "/", "@",
 * ":", whitespace, uppercase letters, or adjacent separators are rejected.
 */
export const MVP_MODEL_DEPLOYMENT_ALIAS_PATTERN = "^[a-z0-9]+(?:[._-][a-z0-9]+)*$" as const;
export const MVP_MODEL_DEPLOYMENT_ALIAS_MAX_LENGTH = 128 as const;

const MODEL_DEPLOYMENT_ALIAS = new RegExp(MVP_MODEL_DEPLOYMENT_ALIAS_PATTERN, "u");

export function isMvpModelDeploymentAlias(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= MVP_MODEL_DEPLOYMENT_ALIAS_MAX_LENGTH &&
    MODEL_DEPLOYMENT_ALIAS.test(value)
  );
}
