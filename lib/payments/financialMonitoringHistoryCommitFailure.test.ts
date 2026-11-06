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

const childSource = "\nconst fs=require(\"node:fs\"),path=require(\"node:path\");\nconst [directory,mode]=process.argv.slice(1);\nconst {advanceFinancialMonitoringHistoryChain:advance}=\n  require(path.resolve(\"lib/payments/advanceFinancialMonitoringHistoryChain.ts\"));\nconst binding={environment:\"local-rehearsal\",database:\"host_test\",schema:\"fixture\"};\nconst originalLink=fs.linkSync;\nfs.linkSync=function(from,to){\n  if(mode===\"before-publication\") throw new Error(\"Injected publication failure\");\n  originalLink.call(fs,from,to);\n  if(mode===\"after-publication\") throw new Error(\"Injected post-publication failure\");\n};\nadvance(directory,binding,null,async()=>({\n  assessedAt:\"2026-10-24T00:00:00.000Z\",pending:[]\n})).then(()=>{\n  if(mode===\"lost-output\") throw new Error(\"Injected output failure\");\n  console.log(\"unexpected-success\");\n}).catch(()=>{\n  console.error(\"Commit fixture failed\");\n  process.exitCode=1;\n});\n";
const binding = {
  environment: "local-rehearsal", database: "host_test", schema: "fixture"
};
const state = {assessedAt: "2026-10-24T00:00:01.000Z", pending: []};

async function rehearsal(mode: string, committed: boolean) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "host-commit-failure-"));
  try {
    const result = spawnSync(process.execPath, [
      "--import", "tsx", "-e", childSource, directory, mode
    ], {encoding: "utf8", timeout: 15000, maxBuffer: 1024 * 1024});
    assert.equal(result.error, undefined);
    assert.equal(result.signal, null);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /Commit fixture failed/);
    assert.equal(fs.existsSync(path.join(directory, ".chain.lock")), false);
    const inspected = inspect(directory, binding);
    assert.equal(inspected.recordCount, committed ? 1 : 0);
    assert.deepEqual(fs.readdirSync(directory),
      committed ? ["00000001.json"] : []);
    if (committed) {
      assert.ok(inspected.head);
      const before = fs.readFileSync(inspected.file!);
      let calls = 0;
      await assert.rejects(advance(directory, binding, null, async () => {
        calls++;
        return state;
      }), /head changed/);
      assert.equal(calls, 0);
      assert.ok(fs.readFileSync(inspected.file!).equals(before));
      const next = await advance(directory, binding, inspected.head,
        async () => state);
      assert.equal(inspect(directory, binding).head, next.head);
      assert.equal(inspect(directory, binding).recordCount, 2);
      assert.ok(fs.readFileSync(inspected.file!).equals(before));
    } else {
      assert.equal(inspected.head, null);
      const next = await advance(directory, binding, null, async () => state);
      assert.equal(inspect(directory, binding).head, next.head);
      assert.equal(inspect(directory, binding).recordCount, 1);
    }
  } finally {
    fs.rmSync(directory, {recursive: true, force: true});
  }
}

test("failure before publication leaves no committed record", async () => {
  await rehearsal("before-publication", false);
});

test("error immediately after publication leaves a validated committed record", async () => {
  await rehearsal("after-publication", true);
});

test("lost success output does not erase the committed record or allow duplicate initialization", async () => {
  await rehearsal("lost-output", true);
});
