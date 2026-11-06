import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { Pool } from "pg";
import { runMigrations, alreadyApplied } from "./migrate";
import { assertSafeTestDatabase } from "../lib/db/testDatabaseGuard";
import { captureSchemaSnapshot, schemaSatisfies } from "./schemaSnapshot";

const directory = path.resolve("migrations");
const files = fs.readdirSync(directory).filter(f => f.endsWith(".sql")).sort();
const latest = "047_financial_runner_heartbeats.sql";
const manifestPath = path.resolve("scripts/migrationSchemaManifest.json");
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
let admin: Pool;
let sourceUrl: URL;

before(async () => {
  assertSafeTestDatabase();
  sourceUrl = new URL(process.env.DATABASE_URL!);
  assert.ok(["localhost", "127.0.0.1", "[::1]", "::1"].includes(sourceUrl.hostname));
  assert.equal(decodeURIComponent(sourceUrl.pathname.slice(1)), "host_test");
  assert.equal(files.length, 48);
  assert.equal(files.at(-1), latest);
  admin = new Pool({
    connectionString: sourceUrl.toString(), max: 1,
    connectionTimeoutMillis: 5000,
    options: "-c statement_timeout=30000 -c lock_timeout=2000"
  });
  const identity = (await admin.query(
    "SELECT current_database() AS name, host(inet_server_addr()) AS address"
  )).rows[0];
  assert.equal(identity.name, "host_test");
  assert.ok(["127.0.0.1", "::1"].includes(identity.address));
});
after(async () => { if (admin) await admin.end(); });

async function disposable(work: (pool: Pool) => Promise<void>) {
  const name = "host_heartbeat_migration_" + crypto.randomBytes(8).toString("hex");
  assert.match(name, /^host_heartbeat_migration_[a-f0-9]{16}$/);
  let created = false;
  let databaseOid: number | undefined;
  let pool: Pool | undefined;
  try {
    await admin.query('CREATE DATABASE "' + name + '" TEMPLATE template0');
    created = true;
    databaseOid = (await admin.query(
      "SELECT oid FROM pg_database WHERE datname=$1", [name]
    )).rows[0].oid;
    const url = new URL(sourceUrl.toString());
    url.pathname = "/" + name;
    pool = new Pool({
      connectionString: url.toString(), max: 3,
      connectionTimeoutMillis: 5000,
      options: "-c statement_timeout=30000 -c lock_timeout=2000"
    });
    const identity = (await pool.query(
      "SELECT current_database() AS name, host(inet_server_addr()) AS address"
    )).rows[0];
    assert.equal(identity.name, name);
    assert.ok(["127.0.0.1", "::1"].includes(identity.address));
    await work(pool);
  } finally {
    if (pool) await pool.end();
    if (created) {
      const current = (await admin.query(
        "SELECT oid FROM pg_database WHERE datname=$1", [name]
      )).rows[0];
      assert.ok(current, "Disposable database unexpectedly missing");
      if (databaseOid !== undefined) assert.equal(current.oid, databaseOid);
      await admin.query('DROP DATABASE "' + name + '"');
      assert.equal((await admin.query(
        "SELECT count(*)::int AS count FROM pg_database WHERE datname=$1", [name]
      )).rows[0].count, 0);
      console.log("Removed disposable database: " + name);
    }
  }
}

async function verifyHeartbeatSchema(pool: Pool) {
  const entry = manifest[latest];
  assert.ok(entry);
  const required = {
    tables: Object.fromEntries(Object.entries(entry.tables).map(
      ([name, columns]) => [name, {name, columns}]
    )),
    constraints: new Map(Object.entries(entry.constraints)),
    indexes: new Map(Object.entries(entry.indexes)),
    functions: new Map(Object.entries(entry.functions)),
    triggers: new Map(Object.entries(entry.triggers)),
    extensions: new Set(entry.extensions)
  };
  const actual = await captureSchemaSnapshot(pool);
  const result = schemaSatisfies(actual, required as any);
  assert.equal(result.complete, true, result.missing.join(", "));
  assert.equal((await pool.query(
    "SELECT count(*)::int AS count FROM financial_runner_heartbeats"
  )).rows[0].count, 0);
}

test("heartbeat migration: fresh installation and unchanged rerun", async () => {
  await disposable(async pool => {
    const first = await runMigrations(pool, directory, files, manifestPath);
    assert.equal(first.length, 48);
    assert.ok(first.every(r => r.outcome === "applied"));
    assert.equal((await alreadyApplied(pool)).size, 48);
    await verifyHeartbeatSchema(pool);
    const second = await runMigrations(pool, directory, files, manifestPath);
    assert.equal(second.length, 48);
    assert.ok(second.every(r => r.outcome === "skipped"));
    await verifyHeartbeatSchema(pool);
  });
});

test("heartbeat migration: upgrade from 046 preserves existing record and ledger", async () => {
  await disposable(async pool => {
    const earlier = files.slice(0, -1);
    await runMigrations(pool, directory, earlier, manifestPath);
    assert.equal((await alreadyApplied(pool)).size, 47);
    assert.equal((await pool.query(
      "SELECT to_regclass('public.financial_runner_heartbeats') AS value"
    )).rows[0].value, null);
    const inserted = await pool.query(
      "INSERT INTO users (email,password_hash,status) VALUES ($1,'x','active') RETURNING id",
      ["heartbeat-upgrade-" + crypto.randomUUID() + "@test.host"]
    );
    const id = inserted.rows[0].id;
    const before = (await pool.query(
      "SELECT to_jsonb(u) AS value FROM users u WHERE id=$1", [id]
    )).rows[0].value;
    const ledgerBefore = (await pool.query(
      "SELECT filename,applied_at FROM schema_migrations ORDER BY filename"
    )).rows;
    const result = await runMigrations(pool, directory, files, manifestPath);
    assert.ok(result.slice(0, -1).every(r => r.outcome === "skipped"));
    assert.deepEqual(result.at(-1), {filename: latest, outcome: "applied"});
    assert.deepEqual((await pool.query(
      "SELECT to_jsonb(u) AS value FROM users u WHERE id=$1", [id]
    )).rows[0].value, before);
    assert.deepEqual((await pool.query(
      "SELECT filename,applied_at FROM schema_migrations WHERE filename<>$1 ORDER BY filename",
      [latest]
    )).rows, ledgerBefore);
    assert.equal((await alreadyApplied(pool)).size, 48);
    await verifyHeartbeatSchema(pool);
    const rerun = await runMigrations(pool, directory, files, manifestPath);
    assert.ok(rerun.every(r => r.outcome === "skipped"));
  });
});
