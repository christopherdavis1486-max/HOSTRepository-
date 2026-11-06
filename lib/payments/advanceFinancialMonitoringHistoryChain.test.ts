import {test} from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {advanceFinancialMonitoringHistoryChain as advance}
  from "./advanceFinancialMonitoringHistoryChain";

const binding = {environment: "local-rehearsal", database: "host_test", schema: "fixture"};
const state = (second = 0) => ({
  assessedAt: new Date(Date.UTC(2026, 9, 23, 20, 0, second)).toISOString(),
  pending: []
});
async function folder(work: (directory: string) => Promise<void>) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "host-history-chain-"));
  try { await work(directory); }
  finally { fs.rmSync(directory, {recursive: true, force: true}); }
}

test("chain advances from the current head and preserves earlier records", async () => {
  await folder(async directory => {
    const first = await advance(directory, binding, null, async previous => {
      assert.equal(previous, null);
      return state();
    });
    const before = fs.readFileSync(first.file);
    const second = await advance(directory, binding, first.head, async previous => {
      assert.deepEqual(previous, state());
      return state(1);
    });
    assert.notEqual(first.head, second.head);
    assert.deepEqual(second.state, state(1));
    assert.ok(fs.readFileSync(first.file).equals(before));
    assert.equal(JSON.parse(fs.readFileSync(second.file, "utf8")).previousHead, first.head);
    assert.deepEqual(fs.readdirSync(directory).sort(), ["00000001.json", "00000002.json"]);
  });
});

test("old predecessor and repeated initialization fail before work", async () => {
  await folder(async directory => {
    const first = await advance(directory, binding, null, async () => state());
    await advance(directory, binding, first.head, async () => state(1));
    let calls = 0;
    for (const head of [null, first.head]) {
      await assert.rejects(advance(directory, binding, head, async () => {
        calls++;
        return state(2);
      }), /head changed/);
    }
    assert.equal(calls, 0);
    assert.deepEqual(fs.readdirSync(directory).sort(), ["00000001.json", "00000002.json"]);
  });
});

test("wrong identity and broken linkage fail before work", async () => {
  await folder(async directory => {
    const first = await advance(directory, binding, null, async () => state());
    let calls = 0;
    const work = async () => {calls++; return state(1);};
    await assert.rejects(advance(directory,
      {...binding, environment: "different"}, first.head, work), /identity mismatch/);
    const changed = JSON.parse(fs.readFileSync(first.file, "utf8"));
    changed.previousHead = "a".repeat(64);
    fs.writeFileSync(first.file, JSON.stringify(changed));
    await assert.rejects(advance(directory, binding, first.head, work), /linkage/);
    assert.equal(calls, 0);
  });
});

test("callback failure and older output leave the head unchanged", async () => {
  await folder(async directory => {
    const first = await advance(directory, binding, null, async () => state(1));
    const before = fs.readFileSync(first.file);
    await assert.rejects(advance(directory, binding, first.head, async () => {
      throw new Error("fixture failure");
    }), /fixture failure/);
    await assert.rejects(advance(directory, binding, first.head,
      async () => state()), /backwards/);
    assert.ok(fs.readFileSync(first.file).equals(before));
    assert.deepEqual(fs.readdirSync(directory), ["00000001.json"]);
    await advance(directory, binding, first.head, async () => state(2));
  });
});

test("sequence gaps and leftover temporary files block advancement", async () => {
  await folder(async directory => {
    const first = await advance(directory, binding, null, async () => state());
    fs.renameSync(first.file, path.join(directory, "00000002.json"));
    let calls = 0;
    const work = async () => {calls++; return state(1);};
    await assert.rejects(advance(directory, binding, first.head, work), /sequence gap/);
    fs.renameSync(path.join(directory, "00000002.json"), first.file);
    const leftover = path.join(directory, ".record-interrupted.tmp");
    fs.writeFileSync(leftover, "{");
    await assert.rejects(advance(directory, binding, first.head, work), /Unexpected/);
    assert.equal(calls, 0);
    assert.equal(fs.readFileSync(leftover, "utf8"), "{");
  });
});
