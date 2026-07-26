const explicitCloud = process.env.DF_CLOUD_EXECUTION === "1";
const knownCloudCi =
  process.env.CI === "true" &&
  Boolean(
    process.env.GITHUB_ACTIONS ||
      process.env.DAYTONA_WORKSPACE_ID ||
      process.env.E2B_SANDBOX_ID ||
      process.env.MODAL_TASK_ID,
  );

if (!explicitCloud && !knownCloudCi) {
  console.error(
    "Refusing to run executable project workloads locally. Run this command in an approved cloud sandbox or cloud CI with DF_CLOUD_EXECUTION=1.",
  );
  process.exit(78);
}
