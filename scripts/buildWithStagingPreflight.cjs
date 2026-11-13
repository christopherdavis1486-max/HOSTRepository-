"use strict";

const { spawnSync } = require("node:child_process");

function run(args) {
  const result = spawnSync(process.execPath, args, {
    stdio: "inherit",
    env: process.env,
  });
  if (result.error) {
    console.error("Build subprocess could not start.");
    process.exit(1);
  }
  if (result.status !== 0) process.exit(result.status || 1);
}

const stagingPreview =
  process.env.VERCEL_ENV === "preview" &&
  process.env.VERCEL_GIT_COMMIT_REF === "host-staging-preview";

if (stagingPreview) {
  console.log("Running staging preflight with Vercel build environment.");
  run(["--import", "tsx", "scripts/verifyStagingConfig.ts"]);
}

run([require.resolve("next/dist/bin/next"), "build"]);
