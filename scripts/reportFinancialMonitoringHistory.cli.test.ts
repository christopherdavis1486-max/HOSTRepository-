import {test} from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {spawnSync} from "node:child_process";
import {financialQueueHealthOperations as operations}
  from "../lib/payments/readFinancialQueueHealth";

function command(args: string[]) {
  return spawnSync(process.execPath, [
    "--import", "tsx", "scripts/reportFinancialMonitoringHistory.ts", ...args
  ], {
    encoding: "utf8", timeout: 15000,
    env: {...process.env, DATABASE_URL: "private-invalid-database-value"}
  });
}
function failed(result: ReturnType<typeof command>) {
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /Financial monitoring history report failed/);
  assert.ok(!result.stderr.includes("private-invalid-database-value"));
}
function fixture(work: (directory: string, policy: string, next: string) => void) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "host-history-cli-"));
  try {
    const policy = path.join(directory, "policy.json");
    fs.writeFileSync(policy, JSON.stringify({
      maxSnapshotAgeMs: 60000, maxHeartbeatAgeMs: 60000,
      operations: Object.fromEntries(operations.map(operation => [
        operation, {expectedState: "running", dueReviewAgeMs: 30000}
      ]))
    }), {flag: "wx"});
    work(directory, policy, path.join(directory, "next.json"));
  } finally {
    fs.rmSync(directory, {recursive: true, force: true});
  }
}

test("CLI exit 1: explicit arguments are required", () => {
  failed(command([]));
});

test("CLI exit 1: invalid policy creates no snapshot and hides its path", () => {
  fixture((directory, policy, next) => {
    fs.writeFileSync(policy, "{");
    const result = command([policy, "-", next]);
    failed(result);
    assert.ok(!result.stderr.includes(directory));
    assert.equal(fs.existsSync(next), false);
  });
});

test("CLI exit 1: missing named previous snapshot never initializes history", () => {
  fixture((directory, policy, next) => {
    const previous = path.join(directory, "missing.json");
    const result = command([policy, previous, next]);
    failed(result);
    assert.ok(!result.stderr.includes(previous));
    assert.equal(fs.existsSync(next), false);
    assert.deepEqual(fs.readdirSync(directory), ["policy.json"]);
  });
});

test("CLI exit 1: corrupt prior history is preserved without next snapshot", () => {
  fixture((directory, policy, next) => {
    const previous = path.join(directory, "previous.json");
    fs.writeFileSync(previous, "{", {flag: "wx"});
    failed(command([policy, previous, next]));
    assert.equal(fs.readFileSync(previous, "utf8"), "{");
    assert.equal(fs.existsSync(next), false);
  });
});

test("CLI exit 1: existing next snapshot is never replaced", () => {
  fixture((directory, policy, next) => {
    const before = Buffer.from("existing-snapshot-preserved");
    fs.writeFileSync(next, before, {flag: "wx"});
    failed(command([policy, "-", next]));
    assert.ok(fs.readFileSync(next).equals(before));
    assert.deepEqual(fs.readdirSync(directory).sort(), ["next.json", "policy.json"]);
  });
});

test("CLI exit 1: invalid database configuration produces no success or state", () => {
  fixture((directory, policy, next) => {
    const before = fs.readFileSync(policy);
    failed(command([policy, "-", next]));
    assert.equal(fs.existsSync(next), false);
    assert.ok(fs.readFileSync(policy).equals(before));
    assert.deepEqual(fs.readdirSync(directory), ["policy.json"]);
  });
});
