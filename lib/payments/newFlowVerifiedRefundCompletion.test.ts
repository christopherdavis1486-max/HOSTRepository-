import { test, mock, before, after } from "node:test";
import assert from "node:assert/strict";

import { db } from "../db";
after(async () => { await db.end(); });

import crypto from "node:crypto";

async function createVerifiedRefundFixture() {
  const suffix = crypto.randomBytes(6).toString("hex");

  const host = await db.query(
    `INSERT INTO users (email, password_hash, status)
     VALUES ($1, 'x', 'active') RETURNING id`,
    [`refund-host-${suffix}@test.host`]
  );

  const profile = await db.query(
    `INSERT INTO host_profiles (user_id, payout_account_status)
     VALUES ($1, 'active') RETURNING id`,
    [host.rows[0].id]
  );

  const property = await db.query(
    `INSERT INTO properties
       (host_id, name, city, currency, nightly_price, max_guests, status)
     VALUES ($1, 'Refund Test', 'Liverpool', 'GBP', 100, 2, 'published')
     RETURNING id`,
    [profile.rows[0].id]
  );

  const guest = await db.query(
    `INSERT INTO users (email, password_hash, status)
     VALUES ($1, 'x', 'active') RETURNING id`,
    [`refund-guest-${suffix}@test.host`]
  );

  const booking = await db.query(
    `INSERT INTO bookings
       (property_id, guest_id, host_id, check_in, check_out,
        guests, status, guest_name, guest_email,
        cancellation_policy_snapshot, payment_flow_version)
     VALUES ($1, $2, $3, '2026-09-01', '2026-09-03',
             1, 'cancelled', 'Refund Guest', 'refund@test.host',
             '[]'::jsonb, 'separate_charges_delayed_v1')
     RETURNING id`,
    [property.rows[0].id, guest.rows[0].id, profile.rows[0].id]
  );

  const expiredAt = new Date(Date.now() - 30 * 60 * 1000);

  await db.query(
    `UPDATE bookings SET hold_expires_at = $2 WHERE id = $1`,
    [booking.rows[0].id, expiredAt]
  );

  await db.query(
    `INSERT INTO audit_log
       (action, object_type, object_id, previous_state, new_state)
     VALUES ('booking_hold_expired', 'booking', $1, $2::jsonb, $3::jsonb)`,
    [
      booking.rows[0].id,
      JSON.stringify({ status: "pending_payment" }),
      JSON.stringify({
        status: "cancelled",
        cancelledBy: "system",
        reason: "payment_hold_expired",
        holdExpiresAt: expiredAt.toISOString()
      })
    ]
  );

  const intentId = `pi_refund_${suffix}`;

  const attempt = await db.query(
    `INSERT INTO payment_attempts
       (booking_id, attempt_number, status, amount_minor,
        currency, idempotency_key, provider_payment_intent_id)
     VALUES ($1, 1, 'succeeded', 25500, 'GBP', $2, $3)
     RETURNING id`,
    [booking.rows[0].id, `refund-attempt-${suffix}`, intentId]
  );

  const input = {
    bookingId: booking.rows[0].id as string,
    paymentAttemptId: attempt.rows[0].id as string,
    providerPaymentIntentId: intentId
  };

  return { input, suffix };
}


let stripeCalls = 0;
let mockRetrieve: (refundId: string) => Promise<any> = async () => {
  throw new Error("Unexpected Stripe request");
};
let completeRefund: typeof import("./newFlowVerifiedRefundCompletion").completeVerifiedNewFlowRefund;

before(async () => {
  mock.module("./stripeClient", {
    namedExports: {
      stripe: {
        refunds: {
          retrieve: async (id: string) => {
            stripeCalls++; return mockRetrieve(id);
          }
        }
      }
    }
  });

  ({ completeVerifiedNewFlowRefund: completeRefund } =
    await import("./newFlowVerifiedRefundCompletion"));
});

test("invalid refund claim is rejected without contacting Stripe", async () => {
  stripeCalls = 0;

  const result = await completeRefund(
    "123e4567-e89b-42d3-a456-426614174000",
    "123e4567-e89b-42d3-a456-426614174001",
    "re_test_invalid_claim"
  );

  assert.deepEqual(result, {
    recorded: false,
    reason: "Refund not eligible for completion"
  });

  assert.equal(stripeCalls, 0);
});

test("verified successful Stripe refund is recorded only once", async () => {
  const { reserveNewFlowRefund, claimNewFlowRefund } =
    await import("./newFlowRefund");

  const { input } = await createVerifiedRefundFixture();
  const reservation = await reserveNewFlowRefund(input);
  const claim = await claimNewFlowRefund(reservation.refundId);

  assert.equal(claim.claimed, true);
  if (!claim.claimed) throw new Error("Refund claim failed");

  const providerRefundId = "re_test_" + reservation.refundId.replace(/-/g, "");

  stripeCalls = 0;
  mockRetrieve = async (id) => ({
    id,
    payment_intent: input.providerPaymentIntentId,
    metadata: { host_refund_id: reservation.refundId },
    amount: 25500,
    currency: "gbp",
    status: "succeeded"
  });

  const result = await completeRefund(
    reservation.refundId,
    claim.claimToken,
    providerRefundId
  );

  assert.deepEqual(result, {
    recorded: true,
    reason: "Verified Stripe refund recorded"
  });

  assert.equal(stripeCalls, 1);

  const duplicate = await completeRefund(
    reservation.refundId,
    claim.claimToken,
    providerRefundId
  );

  assert.equal(duplicate.recorded, false);
  assert.equal(stripeCalls, 1);

  const stored = await db.query(
    `SELECT status, provider_refund_id
     FROM new_flow_refunds WHERE id = $1`,
    [reservation.refundId]
  );

  assert.equal(stored.rows[0].status, "succeeded");
  assert.equal(stored.rows[0].provider_refund_id, providerRefundId);
});

test("pending Stripe refund cannot be recorded as successful", async () => {
  const { reserveNewFlowRefund, claimNewFlowRefund } =
    await import("./newFlowRefund");

  const { input } = await createVerifiedRefundFixture();
  const reservation = await reserveNewFlowRefund(input);
  const claim = await claimNewFlowRefund(reservation.refundId);

  assert.equal(claim.claimed, true);
  if (!claim.claimed) throw new Error("Refund claim failed");

  const providerRefundId = "re_test_" + reservation.refundId.replace(/-/g, "");

  stripeCalls = 0;
  mockRetrieve = async (id) => ({
    id,
    payment_intent: input.providerPaymentIntentId,
    metadata: { host_refund_id: reservation.refundId },
    amount: 25500,
    currency: "gbp",
    status: "pending"
  });

  const result = await completeRefund(
    reservation.refundId,
    claim.claimToken,
    providerRefundId
  );

  assert.deepEqual(result, {
    recorded: false,
    reason: "Stripe refund verification: pending"
  });

  assert.equal(stripeCalls, 1);

  const stored = await db.query(
    `SELECT status, provider_refund_id
     FROM new_flow_refunds WHERE id = $1`,
    [reservation.refundId]
  );

  assert.equal(stored.rows[0].status, "processing");
  assert.equal(stored.rows[0].provider_refund_id, null);
});

test("failed Stripe refund cannot be recorded as successful", async () => {
  const { reserveNewFlowRefund, claimNewFlowRefund } =
    await import("./newFlowRefund");

  const { input } = await createVerifiedRefundFixture();
  const reservation = await reserveNewFlowRefund(input);
  const claim = await claimNewFlowRefund(reservation.refundId);

  assert.equal(claim.claimed, true);
  if (!claim.claimed) throw new Error("Refund claim failed");

  const providerRefundId = "re_test_" + reservation.refundId.replace(/-/g, "");

  stripeCalls = 0;
  mockRetrieve = async (id) => ({
    id,
    payment_intent: input.providerPaymentIntentId,
    metadata: { host_refund_id: reservation.refundId },
    amount: 25500,
    currency: "gbp",
    status: "failed"
  });

  const result = await completeRefund(
    reservation.refundId,
    claim.claimToken,
    providerRefundId
  );

  assert.deepEqual(result, {
    recorded: false,
    reason: "Stripe refund verification: failed"
  });

  assert.equal(stripeCalls, 1);

  const stored = await db.query(
    `SELECT status, provider_refund_id
     FROM new_flow_refunds WHERE id = $1`,
    [reservation.refundId]
  );

  assert.equal(stored.rows[0].status, "processing");
  assert.equal(stored.rows[0].provider_refund_id, null);
});

test("Stripe refund with incorrect amount cannot be recorded as successful", async () => {
  const { reserveNewFlowRefund, claimNewFlowRefund } =
    await import("./newFlowRefund");

  const { input } = await createVerifiedRefundFixture();
  const reservation = await reserveNewFlowRefund(input);
  const claim = await claimNewFlowRefund(reservation.refundId);

  assert.equal(claim.claimed, true);
  if (!claim.claimed) throw new Error("Refund claim failed");

  const providerRefundId = "re_test_" + reservation.refundId.replace(/-/g, "");

  stripeCalls = 0;
  mockRetrieve = async (id) => ({
    id,
    payment_intent: input.providerPaymentIntentId,
    metadata: { host_refund_id: reservation.refundId },
    amount: 20000,
    currency: "gbp",
    status: "succeeded"
  });

  const result = await completeRefund(
    reservation.refundId,
    claim.claimToken,
    providerRefundId
  );

  assert.deepEqual(result, {
    recorded: false,
    reason: "Stripe refund verification: unknown"
  });

  assert.equal(stripeCalls, 1);

  const stored = await db.query(
    `SELECT status, provider_refund_id
     FROM new_flow_refunds WHERE id = $1`,
    [reservation.refundId]
  );

  assert.equal(stored.rows[0].status, "processing");
  assert.equal(stored.rows[0].provider_refund_id, null);
});


for (const change of [
  "refund_amount", "refund_currency", "payment_amount", "payment_currency",
  "payment_reference", "payment_status", "booking_status",
  "lease_expired"
]) {
  test("changed local refund evidence blocks completion: " + change, async () => {
    const { reserveNewFlowRefund, claimNewFlowRefund } = await import("./newFlowRefund");
    const { input } = await createVerifiedRefundFixture();
    const reservation = await reserveNewFlowRefund(input);
    const claim = await claimNewFlowRefund(reservation.refundId);
    if (!claim.claimed) throw new Error("Refund claim failed");
    const providerRefundId = "re_changed_" + reservation.refundId.replace(/-/g, "");
    const statements: Record<string, [string, string]> = {
      refund_amount: ["UPDATE new_flow_refunds SET amount_minor = amount_minor - 1 WHERE id = $1", reservation.refundId],
      refund_currency: ["UPDATE new_flow_refunds SET currency = 'EUR' WHERE id = $1", reservation.refundId],
      payment_amount: ["UPDATE payment_attempts SET amount_minor = amount_minor + 1 WHERE id = $1", input.paymentAttemptId],
      payment_currency: ["UPDATE payment_attempts SET currency = 'EUR' WHERE id = $1", input.paymentAttemptId],
      payment_reference: ["UPDATE payment_attempts SET provider_payment_intent_id = 'pi_changed_' || REPLACE(id::text, '-', '') WHERE id = $1", input.paymentAttemptId],
      payment_status: ["UPDATE payment_attempts SET status = 'processing' WHERE id = $1", input.paymentAttemptId],
      booking_status: ["UPDATE bookings SET status = 'confirmed' WHERE id = $1", input.bookingId],
      lease_expired: ["UPDATE new_flow_refunds SET lease_expires_at = NOW() - INTERVAL '1 minute' WHERE id = $1", reservation.refundId]
    };
    mockRetrieve = async (id) => {
      const [sql, key] = statements[change];
      await db.query(sql, [key]);
      return {
        id, payment_intent: input.providerPaymentIntentId,
        metadata: { host_refund_id: reservation.refundId },
        amount: 25500, currency: "gbp", status: "succeeded"
      };
    };
    assert.equal((await completeRefund(
      reservation.refundId, claim.claimToken, providerRefundId
    )).recorded, false);
    const row = (await db.query(
      "SELECT status, provider_refund_id, claim_token FROM new_flow_refunds WHERE id = $1",
      [reservation.refundId]
    )).rows[0];
    assert.equal(row.status, "processing");
    assert.equal(row.provider_refund_id, null);
    assert.equal(row.claim_token, claim.claimToken);
    assert.equal((await claimNewFlowRefund(reservation.refundId)).claimed, false);
  });
}


test("completion refuses authorization removed during verification", async () => {
  const { reserveNewFlowRefund, claimNewFlowRefund } = await import("./newFlowRefund");
  const { input } = await createVerifiedRefundFixture();
  const { refundId } = await reserveNewFlowRefund(input);
  const claim = await claimNewFlowRefund(refundId);
  if (!claim.claimed) throw new Error("Refund claim failed");
  let mutationReached = false;
  mockRetrieve = async id => {
    await db.query(
      "DELETE FROM audit_log WHERE object_id = $1 AND action = 'booking_hold_expired'",
      [input.bookingId]
    );
    mutationReached = true;
    return {
      id, payment_intent: input.providerPaymentIntentId,
      amount: 25500, currency: "gbp", status: "succeeded",
      metadata: { host_refund_id: refundId }
    };
  };
  assert.equal((await completeRefund(
    refundId, claim.claimToken, "re_auth_" + refundId.replace(/-/g, "")
  )).recorded, false);
  assert.equal(mutationReached, true);
  const row = (await db.query(
    "SELECT status, provider_refund_id, claim_token FROM new_flow_refunds WHERE id = $1",
    [refundId]
  )).rows[0];
  assert.equal(row.status, "processing");
  assert.equal(row.provider_refund_id, null);
  assert.equal(row.claim_token, claim.claimToken);
});

async function failRefundAudit(action: string, run: () => Promise<void>) {
  const originalConnect = db.connect.bind(db);
  const patched = mock.method(db, "connect", function (...args: any[]) {
    if (args.length) return (originalConnect as any)(...args);
    return originalConnect().then(client => {
      const query = client.query.bind(client);
      client.query = ((...queryArgs: any[]) => {
        const sql = typeof queryArgs[0] === "string" ? queryArgs[0] : queryArgs[0]?.text;
        if (sql?.includes("INSERT INTO audit_log") && sql.includes(action)) {
          return Promise.reject(new Error("Injected refund audit failure"));
        }
        return (query as any)(...queryArgs);
      }) as any;
      const release = client.release.bind(client);
      client.release = ((...releaseArgs: any[]) => {
        client.query = query as any;
        client.release = release as any;
        return (release as any)(...releaseArgs);
      }) as any;
      return client;
    });
  } as any);
  try { await run(); } finally { patched.mock.restore(); }
}

test("completion audit failure rolls back refund success and later records one audit", async () => {
  const { reserveNewFlowRefund, claimNewFlowRefund } = await import("./newFlowRefund");
  const { input } = await createVerifiedRefundFixture();
  const { refundId } = await reserveNewFlowRefund(input);
  const claim = await claimNewFlowRefund(refundId);
  if (!claim.claimed) throw new Error("Refund claim failed");
  const providerId = "re_audit_" + refundId.replace(/-/g, "");
  mockRetrieve = async id => ({
    id, payment_intent: input.providerPaymentIntentId,
    amount: 25500, currency: "gbp", status: "succeeded",
    metadata: { host_refund_id: refundId }
  });
  const read = async () => (await db.query(
    "SELECT * FROM new_flow_refunds WHERE id = $1", [refundId]
  )).rows[0];
  const audits = async () => (await db.query(
    "SELECT * FROM audit_log WHERE object_id = $1 AND action = 'new_flow_refund_completed'",
    [refundId]
  )).rows;
  const before = await read();
  await failRefundAudit("new_flow_refund_completed", async () => {
    await assert.rejects(
      completeRefund(refundId, claim.claimToken, providerId),
      /Injected refund audit failure/
    );
  });
  assert.deepEqual(await read(), before);
  assert.equal((await audits()).length, 0);
  assert.equal((await completeRefund(refundId, claim.claimToken, providerId)).recorded, true);
  assert.equal((await completeRefund(refundId, claim.claimToken, providerId)).recorded, false);
  const recorded = await audits();
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].new_state.bookingId, input.bookingId);
  assert.equal(recorded[0].new_state.amountMinor, 25500);
  assert.equal(recorded[0].new_state.providerRefundId, providerId);
});

async function withRefundAuditProbe(action: string, probe: () => Promise<void>, run: () => Promise<void>) {
  const originalConnect = db.connect.bind(db);
  const patched = mock.method(db, "connect", function (...args: any[]) {
    if (args.length) return (originalConnect as any)(...args);
    return originalConnect().then(client => {
      const query = client.query.bind(client);
      client.query = ((...queryArgs: any[]) => {
        const sql = typeof queryArgs[0] === "string" ? queryArgs[0] : queryArgs[0]?.text;
        if (sql?.includes("INSERT INTO audit_log") && sql.includes(action)) {
          return probe().then(() => (query as any)(...queryArgs));
        }
        return (query as any)(...queryArgs);
      }) as any;
      const release = client.release.bind(client);
      client.release = ((...releaseArgs: any[]) => {
        client.query = query as any;
        client.release = release as any;
        return (release as any)(...releaseArgs);
      }) as any;
      return client;
    });
  } as any);
  try { await run(); } finally { patched.mock.restore(); }
}

async function assertRefundRowsLocked(
  table: string, bookingId: string, paymentId: string, refundId: string
) {
  const competing = await db.connect();
  try {
    await competing.query("BEGIN");
    const id = table === "bookings" || table === "audit_log" ? bookingId :
      table === "payment_attempts" ? paymentId : refundId;
    const column = table === "audit_log" ? "object_id" : "id";
    await assert.rejects(
      competing.query(
        "SELECT id FROM " + table + " WHERE " + column + " = $1 FOR UPDATE NOWAIT", [id]
      ),
      (error: any) => error.code === "55P03"
    );
  } finally {
    await competing.query("ROLLBACK");
    competing.release();
  }
}

for (const table of ["bookings", "payment_attempts", "new_flow_refunds", "audit_log"]) {
  test("completion holds evidence locks through audit: " + table, async () => {
    const { reserveNewFlowRefund, claimNewFlowRefund } = await import("./newFlowRefund");
    const { input } = await createVerifiedRefundFixture();
    const { refundId } = await reserveNewFlowRefund(input);
    const claim = await claimNewFlowRefund(refundId);
    if (!claim.claimed) throw new Error("Claim failed");
    mockRetrieve = async id => ({
      id, payment_intent: input.providerPaymentIntentId,
      amount: 25500, currency: "gbp", status: "succeeded",
      metadata: { host_refund_id: refundId }
    });
    let checked = false;
    await withRefundAuditProbe("new_flow_refund_completed", async () => {
      await assertRefundRowsLocked(table, input.bookingId, input.paymentAttemptId, refundId);
      checked = true;
    }, async () => {
      assert.equal((await completeRefund(
        refundId, claim.claimToken, "re_lock_" + refundId.replace(/-/g, "")
      )).recorded, true);
    });
    assert.equal(checked, true);
  });
}

for (const conflict of ["duplicate_audit", "legacy_payment", "legacy_payout"]) {
  test("verification-time financial conflict blocks recording: " + conflict, async () => {
    const { reserveNewFlowRefund, claimNewFlowRefund } = await import("./newFlowRefund");
    const { input } = await createVerifiedRefundFixture();
    const { refundId } = await reserveNewFlowRefund(input);
    const claim = await claimNewFlowRefund(refundId);
    if (!claim.claimed) throw new Error("Claim failed");
    const providerId = "re_conflict_" + refundId.replace(/-/g, "");
    const evidence = {
      id: providerId, payment_intent: input.providerPaymentIntentId,
      amount: 25500, currency: "gbp", status: "succeeded",
      metadata: { host_refund_id: refundId }
    };
    const read = async () => (await db.query(
      "SELECT * FROM new_flow_refunds WHERE id = $1", [refundId]
    )).rows[0];
    const before = await read();
    let mutationReached = false;
    let mutationError: unknown;
    const verification = async () => {
      try {
        if (conflict === "duplicate_audit") {
          await db.query(
            `INSERT INTO audit_log(action, object_type, object_id, previous_state, new_state)
             SELECT action, object_type, object_id, previous_state, new_state
             FROM audit_log WHERE object_id = $1 AND action = 'booking_hold_expired' LIMIT 1`,
            [before.booking_id]
          );
        } else if (conflict === "legacy_payment") {
          await db.query(
            "INSERT INTO payments(booking_id, status, amount_minor, currency) VALUES ($1, 'paid', 25500, 'GBP')",
            [before.booking_id]
          );
        } else {
          await db.query(
            `INSERT INTO payouts(host_id, booking_id, amount_minor, currency, status, scheduled_release_at)
             SELECT host_id, id, 21675, 'GBP', 'scheduled', NOW() FROM bookings WHERE id = $1`,
            [before.booking_id]
          );
        }
        mutationReached = true;
      } catch (error) { mutationError = error; throw error; }
      return evidence;
    };
    mockRetrieve = verification;
    const result = await completeRefund(refundId, claim.claimToken, providerId);
    assert.ifError(mutationError);
    assert.equal(mutationReached, true);
    assert.equal(result.recorded, false);
    assert.deepEqual(await read(), before);
    const audits = await db.query(
      "SELECT id FROM audit_log WHERE object_id = $1 AND action IN ('new_flow_refund_completed', 'new_flow_refund_reconciled')",
      [refundId]
    );
    assert.equal(audits.rows.length, 0);
  });
}
