import {test} from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import {spawn} from "node:child_process";
import {performance} from "node:perf_hooks";
import {financialQueueHealthOperations as operations}
  from "../lib/payments/readFinancialQueueHealth";
import {saveFinancialMonitoringAlertHistory as save}
  from "../lib/payments/financialMonitoringAlertHistoryFile";

test("database handshake outage: bounded CLI failure preserves previous history", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "host-monitor-outage-"));
  const sockets = new Set<net.Socket>();
  const server = net.createServer(socket => {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.on("close", () => sockets.delete(socket));
    // Accept TCP but deliberately never respond as PostgreSQL.
  });
  let listening = false;
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        listening = true;
        resolve();
      });
    });
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const policyFile = path.join(directory, "policy.json");
    const previous = path.join(directory, "previous.json");
    const next = path.join(directory, "next.json");
    fs.writeFileSync(policyFile, JSON.stringify({
      maxSnapshotAgeMs: 60000, maxHeartbeatAgeMs: 60000,
      operations: Object.fromEntries(operations.map(operation => [
        operation, {expectedState: "running", dueReviewAgeMs: 30000}
      ]))
    }), {flag: "wx"});
    save(previous, {assessedAt: "2026-10-21T20:00:00.000Z", pending: []});
    const before = fs.readFileSync(previous);
    const began = performance.now();
    const result = await new Promise<{
      code: number | null; signal: NodeJS.Signals | null;
      stdout: string; stderr: string;
    }>((resolve, reject) => {
      const child = spawn(process.execPath, [
        "--import", "tsx", "scripts/reportFinancialMonitoringHistory.ts",
        policyFile, previous, next
      ], {
        env: {...process.env, DATABASE_URL:
          "postgresql://fixture:private-outage-value@127.0.0.1:" +
          address.port + "/host_test"},
        stdio: ["ignore", "pipe", "pipe"]
      });
      let stdout = "", stderr = "", timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, 15000);
      child.stdout.on("data", chunk => {stdout += String(chunk);});
      child.stderr.on("data", chunk => {stderr += String(chunk);});
      child.once("error", error => {clearTimeout(timer); reject(error);});
      child.once("close", (code, signal) => {
        clearTimeout(timer);
        if (timedOut) reject(new Error("CLI exceeded outage deadline"));
        else resolve({code, signal, stdout, stderr});
      });
    });
    const elapsedMs = performance.now() - began;
    assert.equal(result.code, 1);
    assert.equal(result.signal, null);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /Financial monitoring history report failed/);
    assert.ok(!result.stderr.includes("private-outage-value"));
    assert.ok(elapsedMs < 15000);
    assert.ok(fs.readFileSync(previous).equals(before));
    assert.equal(fs.existsSync(next), false);
    assert.deepEqual(fs.readdirSync(directory).sort(),
      ["policy.json", "previous.json"]);
    console.log("Handshake outage failed visibly in " + Math.round(elapsedMs) +
      " ms; previous snapshot preserved.");
  } finally {
    for (const socket of sockets) socket.destroy();
    if (listening) await new Promise<void>((resolve, reject) =>
      server.close(error => error ? reject(error) : resolve()));
    fs.rmSync(directory, {recursive: true, force: true});
  }
});
