import { test, before, beforeEach, afterEach, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import { Pool, type PoolClient } from "pg";
import { readFinancialQueueHousekeepingReview as read } from "./readFinancialQueueHousekeepingReview";

const definitions = [
  ["042_cancellation_settlement_queue_reviews.sql", "cancellation_settlement_queue_reviews", "settlement_id", "cancellation_host_settlements", ["settlement_execute", "settlement_reconcile"]],
  ["043_new_flow_payment_queue_reviews.sql", "new_flow_payment_queue_reviews", "payment_attempt_id", "payment_attempts", ["payment_reconcile", "missing_refund_recover"]],
  ["044_new_flow_refund_queue_reviews.sql", "new_flow_refund_queue_reviews", "refund_id", "new_flow_refunds", ["refund_execute", "refund_reconcile"]],
  ["045_host_transfer_queue_reviews.sql", "host_transfer_queue_reviews", "entitlement_id", "host_transfer_entitlements", ["transfer_execute", "transfer_reconcile"]],
  ["046_transfer_reversal_queue_reviews.sql", "transfer_reversal_queue_reviews", "reversal_id", "host_transfer_reversals", ["reversal_execute", "reversal_reconcile"]],
] as const;
type Definition = typeof definitions[number];
const cutoff = new Date("2021-01-01T00:00:00.000Z");
const pool = new Pool({connectionString:process.env.DATABASE_URL, max:2});
let client: PoolClient;
let statements: string[];
let releases: boolean[];
let connections: number;
let failQuery: boolean;
let failRollback: boolean;
let alterRows: ((rows:any[]) => any[]) | undefined;
let settings: {readOnly:string; isolation:string} | undefined;

const reportPool = {
  connect: async () => {
    connections++;
    return {
      query: async (text:string, values?:any[]) => {
        statements.push(text);
        if (failRollback && text === "ROLLBACK") throw Error("rollback failure");
        if (text.includes("WITH expected AS")) {
          if (failQuery) throw Error("report query failure");
          settings = {
            readOnly:(await client.query("SHOW transaction_read_only")).rows[0].transaction_read_only,
            isolation:(await client.query("SHOW transaction_isolation")).rows[0].transaction_isolation,
          };
        }
        const result = await client.query(text, values);
        return alterRows && text.includes("WITH expected AS")
          ? {...result, rows:alterRows(result.rows)} : result;
      },
      release: (discard?:boolean) => { releases.push(discard === true); },
    };
  },
} as unknown as Pick<Pool, "connect">;

before(async () => {
  const url = new URL(process.env.DATABASE_URL!);
  assert.ok(["localhost","127.0.0.1","[::1]","::1"].includes(url.hostname));
  assert.equal(decodeURIComponent(url.pathname.slice(1)), "host_test");
  const identity = (await pool.query(
    "SELECT current_database() AS name, host(inet_server_addr()) AS address"
  )).rows[0];
  assert.equal(identity.name, "host_test");
  assert.ok(["127.0.0.1","::1"].includes(identity.address));
});
beforeEach(async () => {
  statements = []; releases = []; connections = 0;
  failQuery = false; failRollback = false; alterRows = undefined; settings = undefined;
  client = await pool.connect();
  for (const [migration, queue, , financial] of definitions) {
    await client.query(`CREATE TEMP TABLE ${financial} (id UUID PRIMARY KEY)`);
    await client.query(fs.readFileSync("migrations/"+migration, "utf8").replace(
      "CREATE TABLE "+queue, () => "CREATE TEMP TABLE "+queue
    ));
  }
});
afterEach(async () => {
  try { await client.query("ROLLBACK"); }
  finally { client.release(true); }
});
after(async () => { await pool.end(); });

async function insert(
  definition:Definition, operation:string, outcome:string,
  options:{source?:boolean; cooling?:boolean; reviewed?:string} = {}
) {
  const [,queue,key,financial] = definition;
  const id = crypto.randomUUID();
  const settlement = queue === "cancellation_settlement_queue_reviews";
  const reviewed = options.reviewed ?? "2020-01-01T00:00:00.000Z";
  const next = options.cooling ? "2099-01-01T00:00:00.000Z"
    : new Date(Date.parse(reviewed)+86400000).toISOString();
  await client.query(`
    INSERT INTO ${queue}
      (operation, ${key}, last_reviewed_at, next_review_at,
       review_failures, last_outcome${settlement ? "" : ", review_token"})
    VALUES ($1,$2,$3,$4,0,$5${settlement ? "" : ", gen_random_uuid()"})
  `,[operation,id,reviewed,next,outcome]);
  if (options.source) await client.query(`INSERT INTO ${financial} VALUES ($1)`,[id]);
  return id;
}
async function snapshot() {
  const result:Record<string,unknown> = {};
  for (const [,queue,key,financial] of definitions) {
    result[queue] = (await client.query(
      `SELECT to_jsonb(q) AS value FROM ${queue} q ORDER BY operation, ${key}`
    )).rows;
    result[financial] = (await client.query(
      `SELECT to_jsonb(f) AS value FROM ${financial} f ORDER BY id`
    )).rows;
  }
  return result;
}

test("empty tables return ten zero-count operations and never authorize deletion", async () => {
  const result = await read(reportPool, cutoff);
  assert.equal(result.scope,"scheduling_housekeeping_review_only");
  assert.equal(result.deletionAuthorized,false);
  assert.equal(result.reviewBefore,cutoff.toISOString());
  assert.equal(result.rows.length,10);
  assert.deepEqual(result.rows.map(row=>row.operation),
    definitions.flatMap(d=>[...d[4]]).sort());
  for (const row of result.rows) {
    for (const [key,value] of Object.entries(row)) {
      if (key !== "operation") assert.equal(value,"0");
    }
  }
});

for (const definition of definitions) {
  for (const operation of definition[4]) {
    test("review categories preserve protected metadata: "+operation, async () => {
      const settlement = operation.startsWith("settlement_");
      const resolved = settlement ? "eligible" : "resolved";
      const unresolved = settlement ? "review_required" : "unresolved";
      const ids = [];
      ids.push(await insert(definition,operation,resolved));
      ids.push(await insert(definition,operation,resolved,{source:true}));
      ids.push(await insert(definition,operation,resolved,{cooling:true}));
      ids.push(await insert(definition,operation,unresolved));
      if (!settlement) ids.push(await insert(definition,operation,"selected"));
      ids.push(await insert(definition,operation,resolved,{reviewed:"2022-01-01T00:00:00.000Z"}));
      ids.push(await insert(definition,operation,resolved,{reviewed:cutoff.toISOString()}));
      const before = await snapshot();
      const result = await read(reportPool,cutoff);
      const row = result.rows.find(row=>row.operation===operation)!;
      assert.equal(row.total,settlement ? "6" : "7");
      assert.equal(row.missingSource,settlement ? "5" : "6");
      assert.equal(row.missingSourceCooling,"1");
      assert.equal(row.selected,settlement ? "0" : "1");
      assert.equal(row.unresolved,"1");
      assert.equal(row.cooling,"1");
      assert.equal(row.oldMissingSourceForReview,"1");
      assert.equal(result.deletionAuthorized,false);
      assert.deepEqual(await snapshot(),before);
      for (const other of result.rows.filter(value=>value.operation!==operation)) {
        assert.equal(other.total,"0");
      }
      for (const id of ids) assert.equal(JSON.stringify(result).includes(id),false);
    });
  }
}

test("new source insertion changes the next snapshot without deleting metadata", async () => {
  const definition = definitions[2];
  const id = await insert(definition,"refund_execute","resolved");
  assert.equal((await read(reportPool,cutoff)).rows.find(
    row=>row.operation==="refund_execute")!.oldMissingSourceForReview,"1");
  await client.query("INSERT INTO new_flow_refunds VALUES ($1)",[id]);
  const row = (await read(reportPool,cutoff)).rows.find(
    row=>row.operation==="refund_execute")!;
  assert.equal(row.total,"1");
  assert.equal(row.missingSource,"0");
  assert.equal(row.oldMissingSourceForReview,"0");
});

test("read-only repeatable-read transaction and connection release are verified", async () => {
  await read(reportPool,cutoff);
  assert.deepEqual(settings,{readOnly:"on",isolation:"repeatable read"});
  assert.equal(statements.at(-1),"COMMIT");
  assert.deepEqual(releases,[false]);
  for (const statement of statements) {
    assert.doesNotMatch(statement,/\b(?:INSERT|UPDATE|DELETE|TRUNCATE|CREATE|ALTER|DROP)\b/i);
    assert.doesNotMatch(statement,/FOR\s+(?:UPDATE|SHARE)|advisory.*lock/i);
  }
});

test("invalid cutoff fails before connection checkout", async () => {
  await assert.rejects(read(reportPool,new Date(NaN)),/cutoff/);
  assert.equal(connections,0);
});
test("future cutoff fails visibly and rolls back", async () => {
  await assert.rejects(read(reportPool,new Date("2099-01-01")),/future cutoff/);
  assert.equal(statements.at(-1),"ROLLBACK");
  assert.deepEqual(releases,[false]);
});
test("query failure is not converted to an empty review", async () => {
  failQuery = true;
  await assert.rejects(read(reportPool,cutoff),/report query failure/);
  assert.equal(statements.at(-1),"ROLLBACK");
  assert.deepEqual(releases,[false]);
});
test("rollback failure discards the connection and preserves the original error", async () => {
  failQuery = failRollback = true;
  await assert.rejects(read(reportPool,cutoff),/report query failure/);
  assert.deepEqual(releases,[true]);
});
test("missing source schema fails visibly instead of treating every row as orphaned", async () => {
  await client.query("SET search_path = pg_temp");
  await client.query("DROP TABLE pg_temp.payment_attempts");
  await assert.rejects(read(reportPool,cutoff),(error:any)=>error.code==="42P01");
  assert.equal(statements.at(-1),"ROLLBACK");
});
for (const [name,change] of [
  ["missing operation",(rows:any[])=>rows.slice(1)],
  ["duplicate operation",(rows:any[])=>[rows[0],rows[0],...rows.slice(2)]],
  ["negative count",(rows:any[])=>[{...rows[0],missing_source:"-1"},...rows.slice(1)]],
  ["numeric count",(rows:any[])=>[{...rows[0],total:0},...rows.slice(1)]],
] as const) {
  test("malformed results fail visibly: "+name,async()=>{
    alterRows=change;
    await assert.rejects(read(reportPool,cutoff),/housekeeping/i);
    assert.equal(statements.at(-1),"ROLLBACK");
  });
}
test("large count strings retain precision",async()=>{
  alterRows=rows=>[{
    ...rows[0],total:"9007199254740993",missing_source:"9007199254740993",
    old_missing_source_for_review:"9007199254740993",
  },...rows.slice(1)];
  const row=(await read(reportPool,cutoff)).rows[0];
  assert.equal(row.total,"9007199254740993");
  assert.equal(row.oldMissingSourceForReview,"9007199254740993");
});
