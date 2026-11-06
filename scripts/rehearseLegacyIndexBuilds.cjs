const assert=require("node:assert/strict");
const fs=require("node:fs");
const crypto=require("node:crypto");
const {Pool}=require("pg");
const {performance}=require("node:perf_hooks");

const output="docs/legacy-index-build-rehearsal-2026-10-21.json";
const quote=s=>'"'+s.replaceAll('"','""')+'"';
async function identity(pool,name) {
  const r=(await pool.query(
    "SELECT current_database() AS name,host(inet_server_addr()) AS address"
  )).rows[0];
  assert.equal(r.name,name);
  assert.ok(["127.0.0.1","::1"].includes(r.address));
}
async function main() {
  assert.ok(!fs.existsSync(output),"Evidence already exists; do not rerun");
  const url=new URL(process.env.DATABASE_URL);
  assert.ok(["postgres:","postgresql:"].includes(url.protocol));
  assert.ok(["127.0.0.1","localhost","::1","[::1]"].includes(url.hostname));
  assert.equal(decodeURIComponent(url.pathname.slice(1)),"host_test");
  const admin=new Pool({
    connectionString:url.toString(),max:1,connectionTimeoutMillis:5000,
    options:"-c statement_timeout=30000 -c lock_timeout=2000"
  });
  const name="host_index_rehearsal_"+crypto.randomBytes(8).toString("hex");
  assert.match(name,/^host_index_rehearsal_[a-f0-9]{16}$/);
  let created=false,createdOid,work;
  const report={
    scope:"disposable_logged_table_index_build_and_storage",
    observedAt:new Date().toISOString(),database:name,
    scales:[10000,100000],cases:[],sourceSchemas:[],
    limitations:[
      "Synthetic logged tables reproduce column types, NOT NULL and existing indexes; defaults, checks, foreign keys and triggers are omitted.",
      "Single build observation per table/scale/mode; fixed order, warm local server.",
      "No concurrent workload during these build measurements.",
      "Write overhead, blocking, failure cleanup and production deployment remain separate checks.",
      "Storage sizes are local observations; not a production sizing guarantee."
    ]
  };
  try {
    await identity(admin,"host_test");
    for(const table of ["refunds","payouts"]) {
      const columns=(await admin.query(
        "SELECT a.attname,format_type(a.atttypid,a.atttypmod) AS type,a.attnotnull "+
        "FROM pg_attribute a WHERE a.attrelid=$1::regclass "+
        "AND a.attnum>0 AND NOT a.attisdropped ORDER BY a.attnum",
        ["public."+table]
      )).rows;
      const indexes=(await admin.query(
        "SELECT indexname,indexdef FROM pg_indexes WHERE schemaname='public' "+
        "AND tablename=$1 ORDER BY indexname",[table]
      )).rows;
      assert.ok(columns.length&&indexes.length);
      report.sourceSchemas.push({table,columns,indexes});
    }
    await admin.query("CREATE DATABASE "+quote(name)+" TEMPLATE template0");
    created=true;
    createdOid=(await admin.query(
      "SELECT oid FROM pg_database WHERE datname=$1",[name]
    )).rows[0].oid;
    const workUrl=new URL(url);
    workUrl.pathname="/"+name;
    work=new Pool({
      connectionString:workUrl.toString(),max:1,connectionTimeoutMillis:5000,
      options:"-c statement_timeout=30000 -c lock_timeout=2000"
    });
    await identity(work,name);
    report.server=(await work.query(
      "SELECT version() AS version,current_setting('synchronous_commit') AS synchronous_commit"
    )).rows[0];
    for(const schema of report.sourceSchemas) {
      const table=schema.table;
      await work.query("CREATE TABLE public."+quote(table)+" ("+
        schema.columns.map(c=>quote(c.attname)+" "+c.type+(c.attnotnull?" NOT NULL":"")).join(",")+")");
      for(const index of schema.indexes) await work.query(index.indexdef);
      const persistence=(await work.query(
        "SELECT relpersistence FROM pg_class WHERE oid=$1::regclass",["public."+table]
      )).rows[0].relpersistence;
      assert.equal(persistence,"p","Expected ordinary logged table");
    }
    for(const count of report.scales) {
      for(const table of ["refunds","payouts"]) {
        await work.query("TRUNCATE public."+quote(table));
        const common=
          "md5('row-'||i::text)::uuid,md5('booking-'||i::text)::uuid,";
        if(table==="refunds") {
          await work.query(
            "INSERT INTO public.refunds "+
            "(id,booking_id,payment_id,amount_minor,currency,reason,initiated_by,status,created_at,updated_at) "+
            "SELECT "+common+"md5('payment-'||i::text)::uuid,10000,'GBP',"+
            "'guest_cancellation','guest','pending',now(),now() FROM generate_series(1,$1::int) i",
            [count]);
        } else {
          await work.query(
            "INSERT INTO public.payouts "+
            "(id,booking_id,host_id,amount_minor,currency,status,scheduled_release_at,created_at,updated_at) "+
            "SELECT "+common+"md5('host-'||i::text)::uuid,10000,'GBP',"+
            "'scheduled',now(),now(),now() FROM generate_series(1,$1::int) i",
            [count]);
        }
        await work.query("ANALYZE public."+quote(table));
        assert.equal(Number((await work.query(
          "SELECT count(*) AS count FROM public."+quote(table)
        )).rows[0].count),count);
        const indexName="trial_"+table+"_booking";
        for(const mode of ["regular","concurrent"]) {
          const started=performance.now();
          await work.query("CREATE INDEX "+(mode==="concurrent"?"CONCURRENTLY ":"")+
            quote(indexName)+" ON public."+quote(table)+" (booking_id)");
          const buildMs=performance.now()-started;
          const state=(await work.query(
            "SELECT i.indisvalid,i.indisready,i.indisunique,"+
            "pg_relation_size(i.indexrelid)::text AS index_bytes,"+
            "pg_relation_size(i.indrelid)::text AS heap_bytes "+
            "FROM pg_index i WHERE i.indexrelid=$1::regclass",
            ["public."+indexName]
          )).rows[0];
          assert.equal(state.indisvalid,true);
          assert.equal(state.indisready,true);
          assert.equal(state.indisunique,false);
          assert.ok(BigInt(state.index_bytes)>0n);
          const plan=(await work.query(
            "EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) SELECT EXISTS "+
            "(SELECT 1 FROM public."+quote(table)+" WHERE booking_id=$1)",
            ["00000000-0000-0000-0000-000000000000"]
          )).rows[0]["QUERY PLAN"][0];
          await work.query("DROP INDEX public."+quote(indexName));
          assert.equal((await work.query(
            "SELECT to_regclass($1) AS value",["public."+indexName]
          )).rows[0].value,null);
          report.cases.push({count,table,mode,buildMs,...state,plan,
            assertions:"logged table, exact row count, valid ready nonunique index and index removal passed"});
          console.log(JSON.stringify({count,table,mode,
            buildMs:Number(buildMs.toFixed(3)),indexBytes:state.index_bytes}));
        }
      }
    }
    assert.equal(report.cases.length,8);
  } finally {
    try {
      if(work) await work.end();
      if(created) {
        const current=(await admin.query(
          "SELECT oid FROM pg_database WHERE datname=$1",[name]
        )).rows[0];
        assert.ok(current,"Created rehearsal database unexpectedly missing");
        assert.equal(current.oid,createdOid,"Database identity changed; refusing removal");
        await admin.query("DROP DATABASE "+quote(name));
        assert.equal((await admin.query(
          "SELECT count(*)::int AS count FROM pg_database WHERE datname=$1",[name]
        )).rows[0].count,0);
        report.disposableDatabaseRemoved=true;
        console.log("Disposable rehearsal database removed.");
      }
    } finally { await admin.end(); }
  }
  assert.equal(report.disposableDatabaseRemoved,true);
  fs.writeFileSync(output,JSON.stringify(report,null,2)+"\n",{flag:"wx"});
  console.log("BUILD REHEARSAL VERIFIED: eight cases; disposable database removed.");
  console.log("Saved "+output);
}
main().catch(error=>{
  console.error("Index build rehearsal failed:",error.message);
  process.exitCode=1;
});
