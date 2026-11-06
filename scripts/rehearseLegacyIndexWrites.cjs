const assert=require("node:assert/strict");
const fs=require("node:fs");
const crypto=require("node:crypto");
const {Pool}=require("pg");
const {performance}=require("node:perf_hooks");

const output="docs/legacy-index-write-rehearsal-2026-10-21.json";
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
    scope:"disposable_logged_table_index_write_comparison",
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

        report.limitations=[
          "Synthetic logged tables retain column types, NOT NULL and existing indexes; defaults, checks, foreign keys and triggers omitted.",
          "Fixed baseline/index/baseline order, warm local server; three timed samples after one warmup.",
          "Each transaction inserts 1000 rows, updates their amount, then changes their indexed booking IDs and commits.",
          "Updates target freshly inserted rows; this does not reproduce arbitrary production update patterns.",
          "Cleanup deletes occur outside timing; dead tuples/index bloat may accumulate between samples.",
          "No concurrent workload, replication measurement or isolated WAL attribution; no production capacity claim."
        ];
        report.writeBatchRows=1000;
        for(const variant of ["baseline_before","indexed","baseline_after"]) {
          await work.query("DROP INDEX IF EXISTS public."+quote(indexName));
          if(variant==="indexed") {
            await work.query("CREATE INDEX "+quote(indexName)+" ON public."+quote(table)+" (booking_id)");
          }
          assert.equal((await work.query(
            "SELECT to_regclass($1) IS NOT NULL AS present",["public."+indexName]
          )).rows[0].present,variant==="indexed");
          const samples=[];
          for(let repeat=0;repeat<4;repeat++) {
            assert.equal(Number((await work.query(
              "SELECT count(*) AS count FROM public."+quote(table)
            )).rows[0].count),count);
            const started=performance.now();
            await work.query("BEGIN");
            let insertMs,amountUpdateMs,bookingUpdateMs,commitMs;
            try {
              let at=performance.now(),insert;
              if(table==="refunds") {
                insert=await work.query(
                  "INSERT INTO public.refunds "+
                  "(id,booking_id,payment_id,amount_minor,currency,reason,initiated_by,status,created_at,updated_at) "+
                  "SELECT md5('write-row-'||i::text)::uuid,md5('write-booking-'||i::text)::uuid,"+
                  "md5('write-payment-'||i::text)::uuid,10000,'GBP','guest_cancellation',"+
                  "'guest','pending',now(),now() FROM generate_series(1,1000) i"
                );
              } else {
                insert=await work.query(
                  "INSERT INTO public.payouts "+
                  "(id,booking_id,host_id,amount_minor,currency,status,scheduled_release_at,created_at,updated_at) "+
                  "SELECT md5('write-row-'||i::text)::uuid,md5('write-booking-'||i::text)::uuid,"+
                  "md5('write-host-'||i::text)::uuid,10000,'GBP','scheduled',now(),now(),now() "+
                  "FROM generate_series(1,1000) i"
                );
              }
              insertMs=performance.now()-at;
              assert.equal(insert.rowCount,1000);
              at=performance.now();
              const amount=await work.query(
                "UPDATE public."+quote(table)+" t SET amount_minor=10001 "+
                "FROM generate_series(1,1000) i WHERE t.id=md5('write-row-'||i::text)::uuid"
              );
              amountUpdateMs=performance.now()-at;
              assert.equal(amount.rowCount,1000);
              at=performance.now();
              const booking=await work.query(
                "UPDATE public."+quote(table)+" t SET booking_id=md5('changed-booking-'||i::text)::uuid "+
                "FROM generate_series(1,1000) i WHERE t.id=md5('write-row-'||i::text)::uuid"
              );
              bookingUpdateMs=performance.now()-at;
              assert.equal(booking.rowCount,1000);
              at=performance.now();
              await work.query("COMMIT");
              commitMs=performance.now()-at;
            } catch(error) {
              await work.query("ROLLBACK");
              throw error;
            }
            const totalMs=performance.now()-started;
            assert.equal(Number((await work.query(
              "SELECT count(*) AS count FROM public."+quote(table)
            )).rows[0].count),count+1000);
            const verified=(await work.query(
              "SELECT count(*)::int AS count FROM public."+quote(table)+" t "+
              "JOIN generate_series(1,1000) i ON t.id=md5('write-row-'||i::text)::uuid "+
              "WHERE t.amount_minor=10001 AND t.booking_id=md5('changed-booking-'||i::text)::uuid"
            )).rows[0].count;
            assert.equal(verified,1000);
            const removed=await work.query(
              "DELETE FROM public."+quote(table)+" t USING generate_series(1,1000) i "+
              "WHERE t.id=md5('write-row-'||i::text)::uuid"
            );
            assert.equal(removed.rowCount,1000);
            assert.equal(Number((await work.query(
              "SELECT count(*) AS count FROM public."+quote(table)
            )).rows[0].count),count);
            if(repeat>0) samples.push({insertMs,amountUpdateMs,bookingUpdateMs,commitMs,totalMs});
          }
          const medians={};
          for(const key of ["insertMs","amountUpdateMs","bookingUpdateMs","commitMs","totalMs"]) {
            medians[key]=samples.map(s=>s[key]).sort((a,b)=>a-b)[1];
          }
          report.cases.push({count,table,variant,batchRows:1000,samples,medians,
            assertions:"index presence, insert/update values, committed row counts and cleanup passed"});
          console.log(JSON.stringify({count,table,variant,
            medians:Object.fromEntries(Object.entries(medians).map(([k,v])=>[k,Number(v.toFixed(3))]))}));
        }
      }
    }
    assert.equal(report.cases.length,12);
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
  console.log("WRITE REHEARSAL VERIFIED: 12 cases; disposable database removed.");
  console.log("Saved "+output);
}
main().catch(error=>{
  console.error("Index write rehearsal failed:",error.message);
  process.exitCode=1;
});
