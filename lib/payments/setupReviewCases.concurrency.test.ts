import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Pool } from "pg";

test("setup review competing updates use separate database transactions", async () => {
  const url = new URL(process.env.DATABASE_URL ?? "");
  assert.ok(["postgres:", "postgresql:"].includes(url.protocol));
  assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(url.hostname));
  assert.equal(url.pathname, "/host_test");
  assert.equal(url.search, "");

  const schema = "test_setup_cases_" + randomUUID().replace(/-/g, "");
  assert.match(schema, /^test_setup_cases_[0-9a-f]{32}$/);
  const control = new Pool({ connectionString: url.toString() });
  const pool = new Pool({
    connectionString: url.toString(),
    options: "-c search_path=" + schema + ",public",
    max: 4,
    connectionTimeoutMillis: 5000,
  });
  let created = false;
  let releaseFirst: (() => void) | undefined;
  try {
    await control.query('CREATE SCHEMA "' + schema + '"');
    created = true;
    for (const table of [
      "users", "admin_roles", "admin_role_permissions",
      "webauthn_credentials", "audit_log",
    ]) {
      await control.query(
        'CREATE TABLE "' + schema + '"."' + table + '" ' +
        '(LIKE public."' + table + '" INCLUDING DEFAULTS INCLUDING CONSTRAINTS INCLUDING INDEXES)'
      );
    }
    await pool.query(readFileSync("migrations/048_setup_review_cases.sql", "utf8"));

    let holdFirst = false;
    let held: (() => void) | undefined;
    let enteringSecond: (() => void) | undefined;
    let heldPromise: Promise<void>;
    let secondPromise: Promise<void>;
    let releasePromise: Promise<void>;

    mock.module("../db", {
      namedExports: {
        db: pool,
        withTransaction: async (fn: any) => {
          const client = await pool.connect();
          try {
            await client.query("BEGIN");
            const result = await fn({
              query: async (sql: string, values?: any[]) => {
                const evidenceLock = sql.includes("SELECT id FROM audit_log") &&
                  sql.includes("FOR UPDATE");
                if (evidenceLock && holdFirst) {
                  holdFirst = false;
                  const result = await client.query(sql, values);
                  held?.();
                  await releasePromise;
                  return result;
                }
                if (evidenceLock) enteringSecond?.();
                return client.query(sql, values);
              },
            });
            await client.query("COMMIT");
            return result;
          } catch (error) {
            await client.query("ROLLBACK");
            throw error;
          } finally { client.release(); }
        },
      },
    });
    const { updateSetupReviewCase: update } = await import("./setupReviewCases");
    const actor = (await pool.query(
      "INSERT INTO users (email,password_hash,status,email_verified_at) " +
      "VALUES ($1,'x','active',NOW()) RETURNING id",
      ["concurrency-" + randomUUID() + "@test.host"]
    )).rows[0].id;
    await pool.query("INSERT INTO admin_roles (user_id,role) VALUES ($1,'super_admin')", [actor]);
    await pool.query(
      "INSERT INTO webauthn_credentials (user_id,credential_id,public_key) VALUES ($1,$2,'test-only')",
      [actor, randomUUID()]
    );
    const bookingId = randomUUID();
    const sourceAuditId = (await pool.query(
      "INSERT INTO audit_log (action,object_type,object_id,new_state) " +
      "VALUES ('setup_webhook_review_required','booking',$1,$2::jsonb) RETURNING id",
      [bookingId, JSON.stringify({ phase: "payment_method_save", requiresReview: true })]
    )).rows[0].id;
    const base = {
      bookingId, sourceAuditId,
      note: "Concurrent investigation test.",
    };

    async function race(input: any) {
      holdFirst = true;
      heldPromise = new Promise(resolve => { held = resolve; });
      secondPromise = new Promise(resolve => { enteringSecond = resolve; });
      releasePromise = new Promise(resolve => { releaseFirst = resolve; });

      // Attach rejection handlers immediately.
      const first = update(actor, input).then(
        value => ({ value, error: null }),
        error => ({ value: null, error }),
      );
      await heldPromise;
      const second = update(actor, input).then(
        value => ({ value, error: null }),
        error => ({ value: null, error }),
      );
      await secondPromise;
      releaseFirst!();
      const results = await Promise.all([first, second]);
      assert.equal(results.filter(result => result.value).length, 1);
      const loser = results.find(result => result.error);
      assert.equal(loser?.error.code, "REVIEW_VERSION_CONFLICT");
    }

    await race({ ...base, expectedVersion: 0, action: "claim" });
    let row = (await pool.query("SELECT * FROM setup_review_cases")).rows[0];
    assert.equal(row.version, 1);
    assert.equal(row.status, "in_review");
    console.log("PASS: competing initial claims create one case and one winner.");

    await race({
      ...base, expectedVersion: 1, action: "resolve",
      resolutionCode: "investigation_complete",
    });
    row = (await pool.query("SELECT * FROM setup_review_cases")).rows[0];
    assert.equal(row.version, 2);
    assert.equal(row.status, "resolved");
    assert.equal(Number((await pool.query(
      "SELECT count(*) FROM audit_log WHERE action='setup_review_case_updated'"
    )).rows[0].count), 2);
    console.log("PASS: competing resolutions produce one update and one audit.");
  } finally {
    releaseFirst?.();
    await pool.end();
    try {
      if (created) await control.query('DROP SCHEMA "' + schema + '" CASCADE');
    } finally { await control.end(); }
  }
});
