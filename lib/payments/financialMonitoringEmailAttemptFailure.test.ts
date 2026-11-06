import {test} from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {spawnSync} from "node:child_process";

const childSource = "\nconst fs=require(\"node:fs\"),path=require(\"node:path\");\nconst [directory,mode]=process.argv.slice(1);\nconst {attemptStoredFinancialMonitoringEmail:attempt}=\n  require(path.resolve(\"lib/payments/attemptStoredFinancialMonitoringEmail.ts\"));\nconst request={\n  occurrenceId:\"a\".repeat(64),transitionHead:\"b\".repeat(64),kind:\"opened\",\n  message:{to:\"operator@example.test\",subject:\"Fixture warning\",body:\"Fixture only\"}\n};\nif(mode===\"outcome-failure\"){\n  const originalOpen=fs.openSync;\n  fs.openSync=function(file,...args){\n    if(String(file).endsWith(\".outcome.json\")){\n      throw new Error(\"Injected outcome publication failure\");\n    }\n    return originalOpen.call(fs,file,...args);\n  };\n}\nattempt(directory,request,async()=>{\n  fs.appendFileSync(path.join(directory,\"sender-calls.txt\"),\"called\\n\");\n  if(mode===\"exit-during-send\") process.exit(9);\n  return {data:{id:\"fixture-accepted\"},error:null};\n}).then(()=>{\n  console.error(\"Unexpected attempt success\");\n  process.exitCode=2;\n}).catch(()=>{\n  console.error(\"Fixture attempt blocked or failed\");\n  process.exitCode=1;\n});\n";

function run(directory: string, mode: string) {
  return spawnSync(process.execPath,[
    "--import","tsx","-e",childSource,directory,mode
  ],{encoding:"utf8",timeout:15000,maxBuffer:1024*1024});
}
function snapshot(directory: string) {
  return fs.readdirSync(directory).sort().map(name=>({
    name,bytes:fs.readFileSync(path.join(directory,name))
  }));
}
function check(result: ReturnType<typeof run>, code: number) {
  assert.equal(result.error,undefined);
  assert.equal(result.signal,null);
  assert.equal(result.status,code);
  assert.equal(result.stdout,"");
}

test("outcome write failure preserves intent and fresh process refuses resend", () => {
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),"host-email-outcome-failure-"));
  try {
    const first=run(directory,"outcome-failure");
    check(first,1);
    assert.match(first.stderr,/Fixture attempt blocked or failed/);
    const names=fs.readdirSync(directory);
    assert.equal(names.filter(name=>name.endsWith(".intent.json")).length,1);
    assert.equal(names.some(name=>name.endsWith(".outcome.json")),false);
    assert.equal(names.includes(".attempt.lock"),false);
    assert.equal(fs.readFileSync(path.join(directory,"sender-calls.txt"),"utf8"),
      "called\n");
    const before=snapshot(directory);
    const retry=run(directory,"retry");
    check(retry,1);
    assert.deepEqual(snapshot(directory),before);
  } finally {
    fs.rmSync(directory,{recursive:true,force:true});
  }
});

test("process exit during mocked send leaves lock and intent and blocks fresh process", () => {
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),"host-email-process-exit-"));
  try {
    const first=run(directory,"exit-during-send");
    check(first,9);
    assert.equal(first.stderr,"");
    const names=fs.readdirSync(directory);
    assert.equal(names.filter(name=>name.endsWith(".intent.json")).length,1);
    assert.equal(names.some(name=>name.endsWith(".outcome.json")),false);
    assert.ok(names.includes(".attempt.lock"));
    assert.equal(fs.readFileSync(path.join(directory,"sender-calls.txt"),"utf8"),
      "called\n");
    const before=snapshot(directory);
    const retry=run(directory,"retry");
    check(retry,1);
    assert.deepEqual(snapshot(directory),before);
  } finally {
    // Dispose only this fixture directory after both children have exited.
    fs.rmSync(directory,{recursive:true,force:true});
  }
});
