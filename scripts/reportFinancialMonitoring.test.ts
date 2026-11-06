import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

function command(args: string[]) {
  return spawnSync(process.execPath, [
    "--import", "tsx", "scripts/reportFinancialMonitoring.ts", ...args
  ], {
    encoding: "utf8", timeout: 15000,
    env: {...process.env, DATABASE_URL: "private-invalid-database-value"}
  });
}

test("report requires explicit policy before database access", () => {
  const result = command([]);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /Financial monitoring report failed/);
  assert.ok(!result.stderr.includes("private-invalid-database-value"));
});

test("report rejects missing policy file without exposing its path", () => {
  const file = path.join(os.tmpdir(), "host-absent-policy-" + process.pid + ".json");
  assert.equal(fs.existsSync(file), false);
  const result = command([file]);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.ok(!result.stderr.includes(file));
});

test("report rejects malformed or invalid policy without database access", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "host-monitor-policy-"));
  try {
    const file = path.join(directory, "policy.json");
    for (const text of ["invalid-json", "{}", JSON.stringify({
      maxSnapshotAgeMs: 60000, maxHeartbeatAgeMs: 0, operations: {}
    })]) {
      fs.writeFileSync(file, text);
      const result = command([file]);
      assert.equal(result.status, 1);
      assert.equal(result.stdout, "");
      assert.ok(!result.stderr.includes("private-invalid-database-value"));
    }
  } finally {
    fs.rmSync(directory, {recursive: true, force: true});
  }
});
