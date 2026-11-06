import {test} from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import {stripTypeScriptTypes} from "node:module";

function harness(fail = false) {
  const page=fs.readFileSync("app/host/onboarding/complete/page.tsx","utf8");
  const begin=page.indexOf("  useEffect(() => {");
  const end=page.indexOf("  }, [update, sessionStatus]);",begin);
  assert.ok(begin>=0 && end>begin,"Completion effect boundary missing");
  const body=page.slice(begin+"  useEffect(() => {".length,end);
  let updates=0,fetches=0,state="checking";
  const context: any={
    sessionStatus:"loading",
    statusCheckStarted:{current:false},
    setStatus:(value:string)=>{state=value;},
    fetch:async()=>{
      fetches++;
      return {json:async()=>({success:true,status:"not_connected"})};
    }
  };
  const newUpdate=()=>async()=>{
    updates++;
    if(fail) throw new Error("Fixture refresh failed");
    return {user:{id:"fixture-user"}};
  };
  context.update=newUpdate();
  vm.runInNewContext(stripTypeScriptTypes("globalThis.effect = () => {"+body+"};"),context);
  return {
    run:(status:string,changeUpdate=false)=>{
      context.sessionStatus=status;
      if(changeUpdate) context.update=newUpdate();
      context.effect();
    },
    flush:()=>new Promise<void>(resolve=>setImmediate(resolve)),
    result:()=>({updates,fetches,state})
  };
}

test("loading waits and changing update references cannot restart the sequence",async()=>{
  const h=harness();
  h.run("loading");
  assert.deepEqual(h.result(),{updates:0,fetches:0,state:"checking"});
  h.run("authenticated");
  h.run("authenticated",true);
  h.run("loading",true);
  h.run("authenticated",true);
  await h.flush();
  for(let i=0;i<10;i++) h.run("authenticated",true);
  await h.flush();
  assert.deepEqual(h.result(),{updates:1,fetches:1,state:"not_connected"});
});

test("signed-out effect makes no requests and can start after authentication",async()=>{
  const h=harness();
  h.run("unauthenticated");
  assert.deepEqual(h.result(),{updates:0,fetches:0,state:"unauthenticated"});
  h.run("authenticated",true);
  await h.flush();
  assert.deepEqual(h.result(),{updates:1,fetches:1,state:"not_connected"});
});

test("refresh rejection stops with error instead of starting a retry loop",async()=>{
  const h=harness(true);
  h.run("authenticated");
  await h.flush();
  for(let i=0;i<10;i++) h.run("authenticated",true);
  await h.flush();
  assert.deepEqual(h.result(),{updates:1,fetches:0,state:"error"});
});
