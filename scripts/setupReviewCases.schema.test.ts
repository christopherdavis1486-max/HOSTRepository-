import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";

test("setup review case schema enforces administrative lifecycle", async () => {
  const url = new URL(process.env.DATABASE_URL ?? "");
  assert.ok(["postgres:", "postgresql:"].includes(url.protocol));
  assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(url.hostname));
  assert.equal(url.pathname, "/host_test");
  assert.equal(url.search, "");

  const pool = new Pool({ connectionString: url.toString(), connectionTimeoutMillis: 5000 });
  const client = await pool.connect();
  let checks = 0;
  try {
    await client.query("BEGIN");
    const isolatedSchema = "test_setup_review_" + randomUUID().replace(/-/g, "");
    assert.match(isolatedSchema, /^test_setup_review_[0-9a-f]{32}$/);
    await client.query('CREATE SCHEMA "' + isolatedSchema + '"');
    await client.query('SET LOCAL search_path TO "' + isolatedSchema + '"');
    for (const table of [
      "users", "admin_roles", "admin_role_permissions",
      "webauthn_credentials", "audit_log",
    ]) {
      await client.query(
        'CREATE TABLE "' + isolatedSchema + '"."' + table + '" ' +
        '(LIKE public."' + table + '" INCLUDING DEFAULTS INCLUDING CONSTRAINTS INCLUDING INDEXES)'
      );
    }

    await client.query("SET LOCAL lock_timeout = '2s'");
    await client.query("SET LOCAL statement_timeout = '5s'");
    const existing = await client.query("SELECT to_regclass('setup_review_cases') AS relation");
    assert.equal(existing.rows[0].relation, null, "Table already exists; preserve it");
    await client.query(readFileSync("migrations/048_setup_review_cases.sql", "utf8"));

    const user = (await client.query(
      "INSERT INTO users (email,password_hash,status) VALUES ($1,'x','active') RETURNING id",
      ["setup-case-schema-" + randomUUID() + "@test.host"]
    )).rows[0].id;
    const bookingId = randomUUID();
    const audit = (await client.query(
      "INSERT INTO audit_log (action,object_type,object_id,new_state) " +
      "VALUES ('setup_webhook_review_required','booking',$1,$2::jsonb) RETURNING id",
      [bookingId, JSON.stringify({ phase: "payment_method_save", requiresReview: true })]
    )).rows[0].id;

    await client.query(
      "INSERT INTO setup_review_cases (source_audit_id,booking_id) VALUES ($1,$2)",
      [audit, bookingId]
    );
    const row = (await client.query(
      "SELECT * FROM setup_review_cases WHERE source_audit_id=$1", [audit]
    )).rows[0];
    assert.equal(row.status, "open");
    assert.equal(row.version, 1);
    assert.equal(row.assigned_to, null);
    checks++;

    async function rejects(sql: string, values: unknown[], code: string) {
      await client.query("SAVEPOINT invalid_case");
      let caught: any;
      try { await client.query(sql, values); } catch (error) { caught = error; }
      await client.query("ROLLBACK TO SAVEPOINT invalid_case");
      await client.query("RELEASE SAVEPOINT invalid_case");
      assert.equal(caught?.code, code, "Unexpected constraint result: " + sql);
      checks++;
    }
    await rejects(
      "INSERT INTO setup_review_cases (source_audit_id,booking_id) VALUES ($1,$2)",
      [audit, bookingId], "23505");
    await rejects(
      "INSERT INTO setup_review_cases (source_audit_id,booking_id) VALUES ($1,$2)",
      [randomUUID(), bookingId], "23503");
    for (const change of [
      "status='invalid'",
      "version=0",
      "status='in_review'",
      "status='resolved'",
      "resolution_note='unexpected'",
      "updated_at=created_at - interval '1 second'"
    ]) {
      await rejects("UPDATE setup_review_cases SET " + change +
        " WHERE source_audit_id=$1", [audit], "23514");
    }

    await client.query(
      "UPDATE setup_review_cases SET assigned_to=$2,status='in_review' WHERE source_audit_id=$1",
      [audit, user]
    );
    checks++;
    for (const note of ["short", " ".repeat(10), "x".repeat(2001)]) {
      await rejects(
        "UPDATE setup_review_cases SET status='resolved',resolved_at=NOW(),resolved_by=$2," +
        "resolution_code='investigation_complete',resolution_note=$3 WHERE source_audit_id=$1",
        [audit, user, note], "23514");
    }
    await client.query(
      "UPDATE setup_review_cases SET status='resolved',resolved_at=NOW(),resolved_by=$2," +
      "resolution_code='investigation_complete',resolution_note='Evidence reviewed; follow-up documented.' " +
      "WHERE source_audit_id=$1", [audit, user]
    );
    checks++;
    await rejects(
      "UPDATE setup_review_cases SET status='open' WHERE source_audit_id=$1",
      [audit], "23514");
    await client.query(
      "UPDATE setup_review_cases SET status='open',resolved_at=NULL,resolved_by=NULL," +
      "resolution_code=NULL,resolution_note=NULL WHERE source_audit_id=$1", [audit]
    );
    checks++;
    console.log(checks + " schema checks passed; transaction will be rolled back.");
  } finally {
    try { await client.query("ROLLBACK"); }
    finally { client.release(); await pool.end(); }
  }
});
