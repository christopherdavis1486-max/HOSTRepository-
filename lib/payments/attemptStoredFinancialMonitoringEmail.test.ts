import {test} from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {attemptStoredFinancialMonitoringEmail as send}
  from "./attemptStoredFinancialMonitoringEmail";

const request = {
  occurrenceId: "a".repeat(64),
  transitionHead: "b".repeat(64),
  kind: "opened" as const,
  message: {to: "operator@example.test", subject: "HOST warning",
    body: "Named monitoring condition requires review."}
};
async function folder(work: (directory: string) => Promise<void>) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "host-email-attempt-"));
  try {await work(directory);}
  finally {fs.rmSync(directory, {recursive:true, force:true});}
}

test("synced intent exists before sender runs and acceptance is stored", async () => {
  await folder(async directory => {
    let calls = 0;
    const result = await send(directory, request, async () => {
      calls++;
      const names = fs.readdirSync(directory);
      const intentName = names.find(name => name.endsWith(".intent.json"))!;
      const intent = JSON.parse(fs.readFileSync(path.join(directory,intentName),"utf8"));
      assert.equal(intent.occurrenceId,request.occurrenceId);
      assert.equal(intent.recipient,request.message.to);
      assert.match(intent.messageDigest,/^[a-f0-9]{64}$/);
      assert.equal(names.some(name => name.endsWith(".outcome.json")),false);
      return {data:{id:"fixture-accepted"},error:null};
    });
    assert.equal(calls,1);
    assert.equal(result.outcome.status,"accepted");
    assert.equal(JSON.parse(fs.readFileSync(result.outcomeFile,"utf8"))
      .outcome.providerMessageId,"fixture-accepted");
    assert.equal(fs.existsSync(path.join(directory,".attempt.lock")),false);
    await assert.rejects(send(directory,{
      ...request, transitionHead:"c".repeat(64),
      message:{...request.message,body:"Changed message"}
    },async () => {calls++;}),/resend refused/);
    assert.equal(calls,1);
  });
});

test("uncertain and rejected outcomes are stored and never automatically retried", async () => {
  for (const rejected of [false,true]) {
    await folder(async directory => {
      let calls = 0;
      const result = await send(directory,request,async () => {
        calls++;
        if (!rejected) throw new Error("private-network-detail");
        return {data:null,error:{message:"private-rejection"}};
      });
      assert.equal(result.outcome.status,rejected ? "rejected" : "uncertain");
      const saved = fs.readFileSync(result.outcomeFile,"utf8");
      assert.ok(!saved.includes("private-"));
      await assert.rejects(send(directory,request,async () => {calls++;}),
        /resend refused/);
      assert.equal(calls,1);
    });
  }
});

test("leftover intent without outcome blocks later calls", async () => {
  await folder(async directory => {
    const first = await send(directory,request,async () =>
      ({data:{id:"fixture-id"},error:null}));
    // Simulate unavailable outcome evidence; retain original intent.
    fs.unlinkSync(first.outcomeFile);
    const before = fs.readFileSync(first.intentFile);
    let calls = 0;
    await assert.rejects(send(directory,request,async () => {calls++;}),
      /resend refused/);
    assert.equal(calls,0);
    assert.ok(fs.readFileSync(first.intentFile).equals(before));
    assert.equal(fs.existsSync(first.outcomeFile),false);
  });
});

test("overlapping caller cannot invoke sender while owner is waiting", async () => {
  await folder(async directory => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => {release=resolve;});
    let calls=0;
    const owner=send(directory,request,async () => {
      calls++;
      await gate;
      return {data:{id:"fixture-id"},error:null};
    });
    try {
      await assert.rejects(send(directory,request,async () => {calls++;}),
        (error:any) => error.code==="EEXIST");
      assert.equal(calls,1);
    } finally {
      release();
      await owner;
    }
  });
});
