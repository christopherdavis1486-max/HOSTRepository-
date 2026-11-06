import {test} from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {withFinancialMonitoringHistoryLock as lock}
  from "./withFinancialMonitoringHistoryLock";

async function folder(work: (directory: string) => Promise<void>) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "host-history-lock-"));
  try { await work(directory); }
  finally { fs.rmSync(directory, {recursive: true, force: true}); }
}

test("overlapping caller is rejected before work and owner completes normally", async () => {
  await folder(async directory => {
    const file = path.join(directory, "chain.lock");
    let release!: () => void;
    const gate = new Promise<void>(resolve => {release = resolve;});
    let entered = 0;
    const owner = lock(file, async () => {
      entered++;
      await gate;
      return "saved";
    });
    try {
      const before = fs.readFileSync(file);
      const metadata = JSON.parse(before.toString("utf8"));
      assert.equal(metadata.pid, process.pid);
      await assert.rejects(lock(file, async () => {
        entered++;
        return "unexpected";
      }), (error: any) => error.code === "EEXIST");
      assert.equal(entered, 1);
      assert.ok(fs.readFileSync(file).equals(before));
    } finally {
      release();
      assert.equal(await owner, "saved");
    }
    assert.equal(fs.existsSync(file), false);
  });
});

test("callback failure propagates and releases the owned lock", async () => {
  await folder(async directory => {
    const file = path.join(directory, "chain.lock");
    const failure = new Error("fixture failure");
    await assert.rejects(lock(file, async () => {throw failure;}),
      error => error === failure);
    assert.equal(fs.existsSync(file), false);
    assert.equal(await lock(file, async () => 42), 42);
  });
});

test("pre-existing old or malformed lock is preserved without automatic takeover", async () => {
  await folder(async directory => {
    const file = path.join(directory, "chain.lock");
    for (const text of ["{", JSON.stringify({
      version: 1, pid: 1, createdAt: "2000-01-01T00:00:00.000Z"
    })]) {
      fs.writeFileSync(file, text);
      let calls = 0;
      await assert.rejects(lock(file, async () => {calls++;}),
        (error: any) => error.code === "EEXIST");
      assert.equal(calls, 0);
      assert.equal(fs.readFileSync(file, "utf8"), text);
    }
  });
});

test("missing parent fails without invoking work or creating directories", async () => {
  await folder(async directory => {
    let calls = 0;
    await assert.rejects(lock(
      path.join(directory, "absent", "chain.lock"),
      async () => {calls++;}
    ), (error: any) => error.code === "ENOENT");
    assert.equal(calls, 0);
    assert.deepEqual(fs.readdirSync(directory), []);
  });
});
