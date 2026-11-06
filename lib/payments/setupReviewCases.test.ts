import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Pool } from "pg";

test("setup review service: transactional lifecycle and access", async t => {
  const url = new URL(process.env.DATABASE_URL ?? "");
  assert.ok(["postgres:", "postgresql:"].includes(url.protocol));
  assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(url.hostname));
  assert.equal(url.pathname, "/host_test");
  assert.equal(url.search, "");
  const pool = new Pool({ connectionString: url.toString(), connectionTimeoutMillis: 5000 });
  const client = await pool.connect();
  let failAudit = false;
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
    assert.equal((await client.query(
      "SELECT to_regclass('setup_review_cases') AS relation"
    )).rows[0].relation, null, "Existing table must be preserved");
    await client.query(readFileSync("migrations/048_setup_review_cases.sql", "utf8"));

    // Real PostgreSQL queries; replace only transaction ownership so every
    // service call is isolated by a savepoint within this rollback-only test.
    mock.module("../db", {
      namedExports: {
        db: { query: (sql: string, values?: any[]) => client.query(sql, values) },
        withTransaction: async (fn: any) => {
          await client.query("SAVEPOINT service_call");
          try {
            const result = await fn({
              query: (sql: string, values?: any[]) => {
                if (failAudit && sql.includes("'setup_review_case_updated'")) {
                  throw new Error("simulated audit write failure");
                }
                return client.query(sql, values);
              },
            });
            await client.query("RELEASE SAVEPOINT service_call");
            return result;
          } catch (error) {
            await client.query("ROLLBACK TO SAVEPOINT service_call");
            await client.query("RELEASE SAVEPOINT service_call");
            throw error;
          }
        },
      },
    });
    const { updateSetupReviewCase: update, getSetupReviewCases: read } = await import("./setupReviewCases");

    async function administrator(role: string, passkey = true) {
      const id = (await client.query(
        "INSERT INTO users (email,password_hash,status,email_verified_at) " +
        "VALUES ($1,'x','active',NOW()) RETURNING id",
        ["setup-review-" + randomUUID() + "@test.host"]
      )).rows[0].id;
      await client.query("INSERT INTO admin_roles (user_id,role) VALUES ($1,$2)", [id, role]);
      if (passkey) {
        await client.query(
          "INSERT INTO webauthn_credentials (user_id,credential_id,public_key) VALUES ($1,$2,'test-only')",
          [id, randomUUID()]
        );
      }
      return id;
    }
    const first = await administrator("super_admin");
    const second = await administrator("super_admin");
    const finance = await administrator("finance");
    const noPasskey = await administrator("super_admin", false);
    const bookingId = randomUUID();
    async function evidence(action = "setup_webhook_review_required") {
      return (await client.query(
        "INSERT INTO audit_log (action,object_type,object_id,new_state) " +
        "VALUES ($1,'booking',$2,$3::jsonb) RETURNING id",
        [action, bookingId, JSON.stringify({
          phase: "payment_method_save", requiresReview: true,
        })]
      )).rows[0].id;
    }
    const sourceAuditId = await evidence();
    const originalEvidence = (await client.query(
      "SELECT * FROM audit_log WHERE id=$1", [sourceAuditId]
    )).rows[0];
    const base = {
      bookingId, sourceAuditId, expectedVersion: 0,
      action: "claim", note: "Investigating setup evidence.",
    };
    const errorCode = (code: string) =>
      (error: any) => error.code === code;
    const state = async () => (await client.query(
      "SELECT * FROM setup_review_cases WHERE source_audit_id=$1", [sourceAuditId]
    )).rows[0];
    const audits = async () => Number((await client.query(
      "SELECT count(*) FROM audit_log WHERE object_id=$1 AND action='setup_review_case_updated'",
      [bookingId]
    )).rows[0].count);

    await t.test("rejects invalid input and client-supplied actor fields", async () => {
      await assert.rejects(update(first, { ...base, actorUserId: second }),
        errorCode("INVALID_REVIEW_UPDATE"));
      await assert.rejects(update(first, { ...base, note: "short" }),
        errorCode("INVALID_REVIEW_UPDATE"));
      await assert.rejects(update(first, { ...base, action: "resolve" }),
        errorCode("INVALID_REVIEW_UPDATE"));
      assert.equal(await audits(), 0);
    });
    await t.test("denies read-only finance, missing passkey and disabled admin", async () => {
      for (const actor of [finance, noPasskey]) {
        await assert.rejects(update(actor, base), errorCode("REVIEW_ACCESS_DENIED"));
      }
      await client.query("UPDATE admin_roles SET disabled_at=NOW() WHERE user_id=$1", [second]);
      await assert.rejects(update(second, base), errorCode("REVIEW_ACCESS_DENIED"));
      await client.query("UPDATE admin_roles SET disabled_at=NULL WHERE user_id=$1", [second]);
      assert.equal(await audits(), 0);
    });
    await t.test("rejects wrong booking and unrelated audit evidence", async () => {
      await assert.rejects(update(first, { ...base, bookingId: randomUUID() }),
        errorCode("REVIEW_NOT_FOUND"));
      await assert.rejects(update(first, { ...base, sourceAuditId: await evidence("unrelated") }),
        errorCode("REVIEW_NOT_FOUND"));
    });
    await t.test("initial claim creates version one and an audit record", async () => {
      const result = await update(first, base);
      assert.equal(result.version, 1);
      assert.equal(result.status, "in_review");
      assert.equal(result.assignedTo, first);
      assert.equal(await audits(), 1);
    });
    await t.test("stale claim cannot overwrite the owner", async () => {
      await assert.rejects(update(second, base), errorCode("REVIEW_VERSION_CONFLICT"));
      assert.equal((await state()).assigned_to, first);
      assert.equal(await audits(), 1);
    });
    await t.test("another operator must claim before resolving", async () => {
      await assert.rejects(update(second, {
        ...base, expectedVersion: 1, action: "resolve",
        resolutionCode: "investigation_complete",
      }), errorCode("REVIEW_NOT_OWNER"));
    });
    await t.test("reassignment increments version and records previous owner", async () => {
      const result = await update(second, { ...base, expectedVersion: 1 });
      assert.equal(result.version, 2);
      assert.equal(result.assignedTo, second);
      const record = (await client.query(
        "SELECT previous_state,new_state FROM audit_log " +
        "WHERE action='setup_review_case_updated' AND object_id=$1 " +
        "AND new_state->>'version'='2'", [bookingId]
      )).rows[0];
      assert.equal(record.previous_state.assignedTo, first);
      assert.equal(record.new_state.assignedTo, second);
    });
    await t.test("audit failure rolls back the case update", async () => {
      const before = await state();
      const count = await audits();
      failAudit = true;
      try {
        await assert.rejects(update(second, {
          ...base, expectedVersion: 2, action: "resolve",
          resolutionCode: "investigation_complete",
        }), /simulated audit write failure/);
      } finally { failAudit = false; }
      assert.deepEqual(await state(), before);
      assert.equal(await audits(), count);
    });
    await t.test("owner can resolve; resolved case rejects ordinary claims", async () => {
      const result = await update(second, {
        ...base, expectedVersion: 2, action: "resolve",
        resolutionCode: "investigation_complete",
      });
      assert.equal(result.status, "resolved");
      assert.equal(result.version, 3);
      assert.equal(result.resolvedBy, second);
      assert.ok(result.resolvedAt);
      await assert.rejects(update(first, { ...base, expectedVersion: 3 }),
        errorCode("REVIEW_RESOLVED"));
    });
    await t.test("reopen clears resolution and assigns acting operator", async () => {
      const result = await update(first, {
        ...base, expectedVersion: 3, action: "reopen",
      });
      assert.equal(result.version, 4);
      assert.equal(result.assignedTo, first);
      assert.equal(result.status, "in_review");
      assert.equal(result.resolvedAt, null);
      assert.equal(result.resolutionCode, null);
      assert.equal(result.resolutionNote, null);
      assert.deepEqual((await client.query(
        "SELECT * FROM audit_log WHERE id=$1", [sourceAuditId]
      )).rows[0], originalEvidence);
    });

    await t.test("reader returns the tracked version without provider payloads", async () => {
      const result = await read(bookingId);
      assert.equal(result.records.length, 1);
      assert.equal(result.records[0].version, 4);
      assert.equal(result.records[0].trackingStatus, "in_review");
      assert.equal(result.records[0].case?.assignedTo, first);
      assert.equal(result.hasMore, false);
      assert.ok(!JSON.stringify(result).includes("setupIntentId"));
      assert.deepEqual(Object.keys(result.records[0]).sort(), [
        "case", "phase", "recordedAt", "sourceAuditId", "trackingStatus", "version",
      ]);
    });
    await t.test("reader rejects invalid IDs and isolates other bookings", async () => {
      await assert.rejects(read("invalid"), errorCode("INVALID_REVIEW_QUERY"));
      const result = await read(randomUUID());
      assert.equal(result.records.length, 0);
      assert.equal(result.hasMore, false);
    });
    await t.test("reader filters object type, phase and review flag", async () => {
      for (const [objectType, payload] of [
        ["payment", { phase: "payment_method_save", requiresReview: true }],
        ["booking", { phase: "unknown", requiresReview: true }],
        ["booking", { phase: "payment_method_save", requiresReview: false }],
      ] as const) {
        await client.query(
          "INSERT INTO audit_log (action,object_type,object_id,new_state) " +
          "VALUES ('setup_webhook_review_required',$1,$2,$3::jsonb)",
          [objectType, bookingId, JSON.stringify(payload)]
        );
      }
      const before = await audits();
      assert.equal((await read(bookingId)).records.length, 1);
      assert.equal(await audits(), before);
    });
    await t.test("reader bounds results and orders timestamp ties by ID", async () => {
      const otherBooking = randomUUID();
      const ids: string[] = [];
      const timestamp = "2026-11-02T12:00:00.000Z";
      for (let i = 0; i < 51; i++) {
        const id = randomUUID();
        ids.push(id);
        await client.query(
          "INSERT INTO audit_log (id,action,object_type,object_id,new_state,created_at) " +
          "VALUES ($1,'setup_webhook_review_required','booking',$2,$3::jsonb,$4)",
          [id, otherBooking, JSON.stringify({
            phase: "immediate_charge", requiresReview: true,
            setupIntentId: "PRIVATE_PROVIDER_REFERENCE",
          }), timestamp]
        );
      }
      const result = await read(otherBooking);
      assert.equal(result.records.length, 50);
      assert.equal(result.hasMore, true);
      assert.deepEqual(result.records.map(row => row.sourceAuditId),
        [...ids].sort().reverse().slice(0, 50));
      assert.ok(result.records.every(row =>
        row.case === null && row.version === 0 &&
        row.trackingStatus === "unclaimed" &&
        row.recordedAt === timestamp));
      assert.ok(!JSON.stringify(result).includes("PRIVATE_PROVIDER_REFERENCE"));

      await client.query("DELETE FROM audit_log WHERE id=$1", [
        [...ids].sort()[0],
      ]);
      const exactly50 = await read(otherBooking);
      assert.equal(exactly50.records.length, 50);
      assert.equal(exactly50.hasMore, false);
    });
  } finally {
    try { await client.query("ROLLBACK"); }
    finally { client.release(); await pool.end(); }
  }
});
