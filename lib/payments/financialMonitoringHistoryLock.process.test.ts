import {test} from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {spawn} from "node:child_process";
import {withFinancialMonitoringHistoryLock as lock}
  from "./withFinancialMonitoringHistoryLock";

const childSource = "\nconst path=require(\"node:path\");\nconst {withFinancialMonitoringHistoryLock:lock}=\n  require(path.resolve(\"lib/payments/withFinancialMonitoringHistoryLock.ts\"));\nlock(process.argv[1],async()=>{\n  process.send({kind:\"locked\"});\n  await new Promise(resolve=>{\n    process.once(\"message\",()=>resolve());\n  });\n}).then(()=>{\n  process.disconnect();\n}).catch(()=>{\n  process.exitCode=1;\n  if(process.connected) process.disconnect();\n});\n";

async function rehearsal(terminate: boolean) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "host-lock-process-"));
  const file = path.join(directory, "chain.lock");
  const child = spawn(process.execPath, [
    "--import", "tsx", "-e", childSource, file
  ], {stdio: ["ignore", "ignore", "pipe", "ipc"]});
  let stderr = "";
  child.stderr!.on("data", chunk => {stderr += String(chunk);});
  let timer: ReturnType<typeof setTimeout> | undefined;
  const closed = new Promise<{code: number | null; signal: NodeJS.Signals | null}>(
    (resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolve({code, signal}));
    }
  );
  try {
    await Promise.race([
      new Promise<void>((resolve, reject) => {
        child.once("message", message => {
          if ((message as any).kind === "locked") resolve();
          else reject(new Error("Unexpected lock fixture message"));
        });
        void closed.then(() => reject(new Error("Lock owner closed before ready")));
      }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          child.kill("SIGKILL");
          reject(new Error("Lock process rehearsal exceeded deadline"));
        }, 15000);
      })
    ]);
    const before = fs.readFileSync(file);
    const metadata = JSON.parse(before.toString("utf8"));
    assert.equal(metadata.pid, child.pid);
    assert.notEqual(metadata.pid, process.pid);
    let calls = 0;
    await assert.rejects(lock(file, async () => {calls++;}),
      (error: any) => error.code === "EEXIST");
    assert.equal(calls, 0);
    assert.ok(fs.readFileSync(file).equals(before));

    if (terminate) {
      assert.equal(child.kill("SIGKILL"), true);
    } else {
      child.send({kind: "release"});
    }
    const outcome = await closed;
    assert.equal(stderr, "");
    if (terminate) {
      assert.ok(outcome.code !== 0 || outcome.signal !== null);
      assert.ok(fs.readFileSync(file).equals(before));
      await assert.rejects(lock(file, async () => {calls++;}),
        (error: any) => error.code === "EEXIST");
      assert.equal(calls, 0);
      assert.ok(fs.readFileSync(file).equals(before));
    } else {
      assert.equal(outcome.code, 0);
      assert.equal(outcome.signal, null);
      assert.equal(fs.existsSync(file), false);
      assert.equal(await lock(file, async () => "next-owner"), "next-owner");
      assert.equal(fs.existsSync(file), false);
    }
  } finally {
    if (timer) clearTimeout(timer);
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
    await closed;
    // Disposable test directory only; never remove an operational lock here.
    fs.rmSync(directory, {recursive: true, force: true});
  }
}

test("another process cannot acquire a live owner's lock", async () => {
  await rehearsal(false);
});

test("terminated owner leaves its lock and automatic takeover is refused", async () => {
  await rehearsal(true);
});
