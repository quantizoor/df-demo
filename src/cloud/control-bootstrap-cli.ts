#!/usr/bin/env node

import {
  launchDaytonaControlPlane,
  OfficialDaytonaControlClientFactory,
  parseCloudControlBootstrapEnvironment,
} from "./control-bootstrap.js";

const [command, campaignId] = process.argv.slice(2);

try {
  if (command === undefined || campaignId === undefined) {
    throw new Error("command and campaign id are required");
  }
  const request = parseCloudControlBootstrapEnvironment(
    process.env,
    command,
    campaignId,
  );
  const receipt = await launchDaytonaControlPlane(
    request,
    new OfficialDaytonaControlClientFactory(),
  );
  process.stdout.write(`${JSON.stringify(receipt)}\n`);
} catch {
  process.stderr.write(
    `${JSON.stringify({
      ok: false,
      code: "DF_CLOUD_BOOTSTRAP_FAILED",
      message:
        "Trusted cloud bootstrap failed closed. Inspect protected cloud logs.",
    })}\n`,
  );
  process.exitCode = 1;
}
