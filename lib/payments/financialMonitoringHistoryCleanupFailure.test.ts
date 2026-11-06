import {test} from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {spawnSync} from "node:child_process";
import {advanceFinancialMonitoringHistoryChain as advance}
  from "./advanceFinancialMonitoringHistoryChain";
import {inspectFinancialMonitoringHistoryChain as inspect}
  from "./inspectFinancialMonitoringHistoryChain";
import {decodeBoundFinancialMonitoringHistory as decode}
  from "./financialMonitoringBoundHistoryCodec";

const childSource = "\nconst fs=require(\"node:fs\"),path=require(\"node:path\");\nconst [directory,mode]=process.argv.slice(1);\nconst {advanceFinancialMonitoringHistoryChain:advance}=\n  require(path.resolve(\"lib/payments/advanceFinancialMonitoringHistoryChain.ts\"));\nconst originalUnlink=fs.unlinkSync;\nlet injected=0;\nfs.unlinkSync=function(file){\n  const name=path.basename(String(file));\n  const matches=mode===\"temporary\"\n    ? name.startsWith(\".record-\")&&name.endsWith(\".tmp\")\n    : name===\".chain.lock\";\n  if(matches){\n    injected++;\n    throw new Error(\"Injected cleanup failure\");\n  }\n  return originalUnlink.call(fs,file);\n};\nadvance(directory,{\n  environment:\"local-rehearsal\",database:\"host_test\",schema:\"fixture\"\n},null,async()=>({\n  assessedAt:\"2026-10-24T00:00:00.000Z\",pending:[]\n})).then(()=>{\n  console.error(\"Unexpected fixture success\");\n  process.exitCode=2;\n}).catch(()=>{\n  console.error(\"Cleanup fixture failed; injected=\"+injected);\n  process.exitCode=1;\n});\n";
const binding = {
  environment: "local-rehearsal", database: "host_test", schema: "fixture"
};
const state = {assessedAt: "2026-10-24T00:00:00.000Z", pending: []};

function snapshot(directory: string) {
  return fs.readdirSync(directory).sort().map(name => ({
    name, bytes: fs.readFileSync(path.join(directory, name))
  }));
}

async function rehearsal(mode: "temporary" | "lock") {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "host-cleanup-failure-"));
  try {
    const result = spawnSync(process.execPath, [
      "--import", "tsx", "-e", childSource, directory, mode
    ], {encoding: "utf8", timeout: 15000, maxBuffer: 1024 * 1024});
    assert.equal(result.error, undefined);
    assert.equal(result.signal, null);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /Cleanup fixture failed; injected=1/);

    const recordFile = path.join(directory, "00000001.json");
    const recordBytes = fs.readFileSync(recordFile);
    const record = JSON.parse(recordBytes.toString("utf8"));
    assert.equal(record.version, 1);
    assert.equal(record.sequence, 1);
    assert.equal(record.previousHead, null);
    assert.deepEqual(decode(JSON.stringify(record.snapshot), binding), state);

    const names = fs.readdirSync(directory).sort();
    if (mode === "temporary") {
      assert.equal(names.length, 2);
      const temporary = names.find(name => name.startsWith(".record-"))!;
      assert.ok(temporary && temporary.endsWith(".tmp"));
      assert.ok(fs.readFileSync(path.join(directory, temporary)).equals(recordBytes));
      assert.equal(fs.existsSync(path.join(directory, ".chain.lock")), false);
    } else {
      assert.deepEqual(names, [".chain.lock", "00000001.json"]);
      const owner = JSON.parse(fs.readFileSync(
        path.join(directory, ".chain.lock"), "utf8"));
      assert.equal(owner.version, 1);
      assert.ok(Number.isInteger(owner.pid) && owner.pid > 0);
    }

    const before = snapshot(directory);
    assert.throws(() => inspect(directory, binding),
      mode === "temporary" ? /Unexpected/ : /lock present/);
    assert.deepEqual(snapshot(directory), before);

    let calls = 0;
    await assert.rejects(advance(directory, binding, null, async () => {
      calls++;
      return state;
    }), mode === "temporary"
      ? /Unexpected/
      : (error: any) => error.code === "EEXIST");
    assert.equal(calls, 0);
    assert.deepEqual(snapshot(directory), before);
    assert.ok(fs.readFileSync(recordFile).equals(recordBytes));
  } finally {
    // Dispose only this test's folder after the child has exited.
    // No recovery or lock removal API is being exercised.
    fs.rmSync(directory, {recursive: true, force: true});
  }
}

test("temporary-name cleanup failure preserves committed record and blocks continuation", async () => {
  await rehearsal("temporary");
});

test("lock cleanup failure preserves committed record and refuses takeover", async () => {
  await rehearsal("lock");
});
