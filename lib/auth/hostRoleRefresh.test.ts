import {test} from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import {stripTypeScriptTypes} from "node:module";

function harness(hostRows: any[], adminRows: any[]) {
  const queries: {sql: string; args: any[]}[] = [];
  const context: any = {
    process: {env: {}},
    CredentialsProvider: (options: any) => options,
    GoogleProvider: () => {throw new Error("Unexpected Google provider");},
    db: {query: async (sql: string, args: any[]) => {
      queries.push({sql, args});
      if (sql.startsWith("SELECT id FROM host_profiles")) return {rows: hostRows};
      if (sql.startsWith("SELECT role FROM admin_roles")) return {rows: adminRows};
      throw new Error("Unexpected database query");
    }}
  };
  const original=fs.readFileSync("lib/auth/authOptions.ts","utf8");
  const executable=stripTypeScriptTypes(
    original.replace(/^import .*;\r?\n/gm,"")
      .replace(/^export /gm,"")
  );
  vm.runInNewContext(executable+
    "\nglobalThis.callbacks = authOptions.callbacks;",context);
  return {callbacks: context.callbacks, queries};
}
const token=()=>({
  userId: "session-user", roles: ["guest"],
  hostProfileId: null, adminRole: null,
  sessionVersion: 7, sessionId: "existing-session"
});
const plain=(value: any)=>JSON.parse(JSON.stringify(value));

test("update discovers the new host profile without creating another auth session", async () => {
  const h=harness([{id:"server-host"}],[]);
  const result=await h.callbacks.jwt({token:token(),trigger:"update"});
  assert.deepEqual(plain(result.roles),["guest","host"]);
  assert.equal(result.hostProfileId,"server-host");
  assert.equal(result.adminRole,null);
  assert.equal(result.sessionId,"existing-session");
  assert.equal(result.sessionVersion,7);
  assert.equal(h.queries.length,2);
  assert.ok(h.queries.every(row=>row.args[0]==="session-user"));

  const session=await h.callbacks.session({
    session:{user:{email:"fixture@example.test"}},token:result
  });
  assert.deepEqual(plain(session.user.roles),["guest","host"]);
  assert.equal(session.user.hostProfileId,"server-host");
});

test("client update claims cannot grant host or admin access", async () => {
  const h=harness([],[]);
  const result=await h.callbacks.jwt({
    token:token(),trigger:"update",
    session:{userId:"other-user",roles:["admin","host"],
      hostProfileId:"forged-host",adminRole:"finance",
      sessionVersion:999,sessionId:"forged-session"}
  });
  assert.deepEqual(plain(result.roles),["guest"]);
  assert.equal(result.hostProfileId,null);
  assert.equal(result.adminRole,null);
  assert.equal(result.sessionId,"existing-session");
  assert.equal(result.sessionVersion,7);
  assert.ok(h.queries.every(row=>row.args[0]==="session-user"));
});

test("update removes stale host and admin claims when database roles are absent", async () => {
  const h=harness([],[]);
  const stale={...token(),roles:["guest","host","admin"],
    hostProfileId:"old-host",adminRole:"finance"};
  const result=await h.callbacks.jwt({token:stale,trigger:"update"});
  assert.deepEqual(plain(result.roles),["guest"]);
  assert.equal(result.hostProfileId,null);
  assert.equal(result.adminRole,null);
  assert.equal(h.queries.length,2);
});
