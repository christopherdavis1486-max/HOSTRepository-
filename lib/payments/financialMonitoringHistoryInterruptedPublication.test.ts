import {test} from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {spawn} from "node:child_process";
import {advanceFinancialMonitoringHistoryChain as advance}
  from "./advanceFinancialMonitoringHistoryChain";
import {inspectFinancialMonitoringHistoryChain as inspect}
  from "./inspectFinancialMonitoringHistoryChain";
import {decodeBoundFinancialMonitoringHistory as decode}
  from "./financialMonitoringBoundHistoryCodec";

const childSource = "\nconst fs=require(\"node:fs\"),path=require(\"node:path\");\nconst [directory,mode]=process.argv.slice(1);\nconst {advanceFinancialMonitoringHistoryChain:advance}=\n  require(path.resolve(\"lib/payments/advanceFinancialMonitoringHistoryChain.ts\"));\nconst originalLink=fs.linkSync;\nfs.linkSync=function(from,to){\n  if(mode===\"after\") originalLink.call(fs,from,to);\n  process.send({kind:\"publication-boundary\",mode},()=>{\n    // Keep the synchronous publication call suspended until the parent kills us.\n    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);\n  });\n  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);\n};\nadvance(directory,{\n  environment:\"local-rehearsal\",database:\"host_test\",schema:\"fixture\"\n},null,async()=>({\n  assessedAt:\"2026-10-24T00:00:00.000Z\",pending:[]\n})).then(()=>process.exit(2)).catch(()=>process.exit(3));\n";
const binding = {
  environment: "local-rehearsal", database: "host_test", schema: "fixture"
};
const state = {assessedAt: "2026-10-24T00:00:00.000Z", pending: []};

function snapshot(directory: string) {
  return fs.readdirSync(directory).sort().map(name => ({
    name, bytes: fs.readFileSync(path.join(directory, name))
  }));
}

async function rehearsal(mode: "before" | "after") {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "host-publication-kill-"));
  const child = spawn(process.execPath, [
    "--import", "tsx", "-e", childSource, directory, mode
  ], {stdio: ["ignore", "pipe", "pipe", "ipc"]});
  let stdout = "", stderr = "";
  child.stdout!.on("data", chunk => {stdout += String(chunk);});
  child.stderr!.on("data", chunk => {stderr += String(chunk);});
  const closed = new Promise<{code: number | null; signal: NodeJS.Signals | null}>(
    (resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolve({code, signal}));
    }
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      new Promise<void>((resolve, reject) => {
        child.once("message", message => {
          const row = message as any;
          if (row.kind === "publication-boundary" && row.mode === mode) resolve();
          else reject(new Error("Unexpected publication fixture message"));
        });
        void closed.then(() => reject(new Error("Child exited before publication boundary")));
      }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          child.kill("SIGKILL");
          reject(new Error("Publication rehearsal exceeded deadline"));
        }, 15000);
      })
    ]);
    assert.equal(child.kill("SIGKILL"), true);
    const outcome = await closed;
    assert.ok(outcome.code !== 0 || outcome.signal !== null);
    assert.equal(stdout, "");
    assert.equal(stderr, "");

    const names = fs.readdirSync(directory).sort();
    const temporary = names.filter(name =>
      name.startsWith(".record-") && name.endsWith(".tmp"));
    assert.equal(temporary.length, 1);
    assert.ok(names.includes(".chain.lock"));
    assert.equal(names.length, mode === "before" ? 2 : 3);
    const owner = JSON.parse(fs.readFileSync(
      path.join(directory, ".chain.lock"), "utf8"));
    assert.equal(owner.pid, child.pid);

    const tempBytes = fs.readFileSync(path.join(directory, temporary[0]));
    const record = JSON.parse(tempBytes.toString("utf8"));
    assert.equal(record.sequence, 1);
    assert.equal(record.previousHead, null);
    assert.deepEqual(decode(JSON.stringify(record.snapshot), binding), state);
    const committed = path.join(directory, "00000001.json");
    if (mode === "after") {
      assert.ok(fs.readFileSync(committed).equals(tempBytes));
    } else {
      assert.equal(fs.existsSync(committed), false);
    }

    const before = snapshot(directory);
    assert.throws(() => inspect(directory, binding), /lock present/);
    let calls = 0;
    await assert.rejects(advance(directory, binding, null, async () => {
      calls++;
      return state;
    }), (error: any) => error.code === "EEXIST");
    assert.equal(calls, 0);
    assert.deepEqual(snapshot(directory), before);
  } finally {
    if (timer) clearTimeout(timer);
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await closed;
    // Test teardown only, after confirmed child exit; no recovery action.
    fs.rmSync(directory, {recursive: true, force: true});
  }
}

test("termination before publication leaves synced temporary record and lock", async () => {
  await rehearsal("before");
});

test("termination after publication preserves committed record, temporary name and lock", async () => {
  await rehearsal("after");
});
