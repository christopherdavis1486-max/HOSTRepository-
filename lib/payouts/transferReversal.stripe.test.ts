import { test, mock, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import crypto from "crypto";
import { db } from "../db";

let beforeProviderCall: (() => Promise<void>) | undefined;
let afterProviderCall: (() => Promise<void>) | undefined;
let mockCreateReversal: any;
let mockListReversals: any;
let mockRetrieveTransfer: any;
let transferRetrieveCalls = 0;
const originalTransferFixtures = new Map<string, any>();
let executeReversal: typeof import("./transferReversal").executeReversal;
let requestReversal: typeof import("./transferReversal").requestReversal;
let createEntitlement: typeof import("./hostTransfers").createEntitlement;
let claimEntitlement: typeof import("./hostTransfers").claimEntitlement;

before(async () => {
  const real = await import("./withTransferReversalProviderLock");
  mock.module("./withTransferReversalProviderLock", {
    namedExports: {
      reversalFinancialEligibility: real.reversalFinancialEligibility,
      withTransferReversalProviderLock: async (expected: any, execute: any) => {
        const preflight = beforeProviderCall;
        beforeProviderCall = undefined;
        if (preflight) await preflight();
        try {
          return await real.withTransferReversalProviderLock(expected, execute);
        } finally {
          const hook = afterProviderCall;
          afterProviderCall = undefined;
          if (hook) await hook();
        }
      },
    },
  });
  mock.module("../payments/stripeClient", {
    namedExports: {
      stripe: {
        transfers: {
          createReversal: async (...args: any[]) => mockCreateReversal(...args),
          listReversals: async (...args: any[]) => {
            const page = await mockListReversals(...args);
            const original = originalTransferFixtures.get(args[0]);
            if (original && Array.isArray(page.data)) {
              for (const reversal of page.data) {
                if (reversal.metadata?.host_reversal_id && Number.isSafeInteger(reversal.amount)) {
                  original.amount_reversed += reversal.amount;
                }
              }
              original.reversed = original.amount_reversed === original.amount;
            }
            return page;
          },
          retrieve: async (id: string) => {
            transferRetrieveCalls++;
            return mockRetrieveTransfer(id);
          },
        },
      },
    },
  });
  ({ executeReversal, requestReversal } = await import("./transferReversal"));
  ({ createEntitlement, claimEntitlement } = await import("./hostTransfers"));

  const check = await db.query(`SELECT COUNT(*) FROM fee_configs WHERE active = TRUE`);
  if (Number(check.rows[0].count) === 0) throw new Error("No active fee_configs row — run scripts/seedFeeConfig.ts first");
});
after(async () => { await db.end(); });

async function setupTransferredEntitlement(suffix: string) {
  const hostUser = await db.query(`INSERT INTO users (email, password_hash, status) VALUES ($1, 'x', 'active') RETURNING id`, [`b9b-tr-host-${suffix}@test.host`]);
  const hostProfile = await db.query(`INSERT INTO host_profiles (user_id, stripe_connect_account_id, payout_account_status) VALUES ($1, 'acct_test', 'active') RETURNING id`, [hostUser.rows[0].id]);
  const property = await db.query(`INSERT INTO properties (host_id, name, city, currency, nightly_price, max_guests, status) VALUES ($1, 'TR Stripe Test', 'Liverpool', 'GBP', 100, 2, 'published') RETURNING id`, [hostProfile.rows[0].id]);
  const guestUser = await db.query(`INSERT INTO users (email, password_hash, status) VALUES ($1, 'x', 'active') RETURNING id`, [`b9b-tr-guest-${suffix}@test.host`]);
  const booking = await db.query(
    `INSERT INTO bookings (property_id, guest_id, host_id, check_in, check_out, guests, status, guest_name, guest_email, cancellation_policy_snapshot, payment_flow_version)
     VALUES ($1, $2, $3, '2026-12-01', '2026-12-03', 1, 'confirmed', 'TR Guest', 'tr@test.host', '[]', 'separate_charges_delayed_v1') RETURNING id`,
    [property.rows[0].id, guestUser.rows[0].id, hostProfile.rows[0].id]
  );
  await db.query(
    `INSERT INTO booking_price_components
       (booking_id, currency, accommodation_minor, cleaning_minor,
        guest_service_fee_minor, taxes_minor, guest_total_minor,
        host_commission_minor, host_payout_minor, host_revenue_minor, fee_config_version)
     VALUES ($1, 'GBP', 24000, 0, 0, 0, 24000, 4000, 20000, 4000, 'test')`,
    [booking.rows[0].id]
  );
  await db.query(
    `INSERT INTO payment_attempts
       (booking_id, attempt_number, status, amount_minor, currency,
        idempotency_key, provider_payment_intent_id)
     VALUES ($1, 1, 'succeeded', 24000, 'GBP', $2, $3)`,
    [booking.rows[0].id, "reversal-paid-" + suffix, "pi_reversal_paid_" + suffix]
  );
  const entitlementId = await createEntitlement({ bookingId: booking.rows[0].id, hostId: hostProfile.rows[0].id, amountMinor: 20000, taxAmountMinor: null, currency: "GBP", scheduledReleaseAt: new Date() });
  await claimEntitlement(entitlementId!, "worker-test");
  await db.query(`UPDATE host_transfer_entitlements SET status = 'transfer_created', provider_transfer_id = $2 WHERE id = $1`, [entitlementId, `tr_real_transfer_${suffix}`]);
  originalTransferFixtures.set("tr_real_transfer_" + suffix, {
    id: "tr_real_transfer_" + suffix, amount: 20000, currency: "gbp",
    destination: "acct_test", metadata: { host_entitlement_id: entitlementId },
    reversed: false, amount_reversed: 0,
  });
  return entitlementId as string;
}


async function authorizeRefundReversal(entitlementId: string, reversalId: string, percent: number) {
  const e = (await db.query(
    "SELECT * FROM host_transfer_entitlements WHERE id = $1", [entitlementId]
  )).rows[0];
  const p = (await db.query(
    "SELECT * FROM payment_attempts WHERE booking_id = $1", [e.booking_id]
  )).rows[0];
  const refundableMinor = Math.round(p.amount_minor * percent / 100);
  const hostRetainedMinor = Math.round(e.amount_minor * (100 - percent) / 100);
  const refund = await db.query(
    `INSERT INTO new_flow_refunds
       (booking_id, payment_attempt_id, amount_minor, currency, reason, initiated_by, status)
     VALUES ($1, $2, $3, $4, 'guest_cancellation', 'guest', 'pending') RETURNING id`,
    [e.booking_id, p.id, refundableMinor, e.currency]
  );
  await db.query("UPDATE bookings SET status = 'cancelled' WHERE id = $1", [e.booking_id]);
  await db.query(
    `INSERT INTO audit_log(action, object_type, object_id, previous_state, new_state)
     VALUES ('booking_cancelled', 'booking', $1, $2::jsonb, $3::jsonb)`,
    [e.booking_id, JSON.stringify({ status: "confirmed" }), JSON.stringify({
      status: "cancelled", cancelledBy: "guest", cancellationKind: "paid",
      paymentFlowVersion: "separate_charges_delayed_v1",
      refundPercent: percent, refundableMinor, hostRetainedMinor,
      refundId: refund.rows[0].id, reversalId, entitlementId,
      settlementId: null, retainedPayoutSettlementRequired: false,
    })]
  );
}

test("a real reversal is executed and correctly confirmed with genuine provider evidence", async () => {
  const suffix = crypto.randomBytes(4).toString("hex");
  const entitlementId = await setupTransferredEntitlement(suffix);
  const reversalId = await requestReversal(entitlementId, 20000, "refund");
  await authorizeRefundReversal(entitlementId, reversalId!, 100);

  mockListReversals = async () => ({ data: [], has_more: false });
  mockCreateReversal = async () => ({
    id: "trr_test_reversal_123", transfer: "tr_real_transfer_" + suffix,
    amount: 20000, currency: "gbp", metadata: { host_reversal_id: reversalId }
  });

  const result = await executeReversal(reversalId!);
  assert.equal(result.attempted, true);
  assert.equal(result.providerReversalId, "trr_test_reversal_123");

  const row = await db.query(`SELECT status, provider_reversal_id, confirmed_at FROM host_transfer_reversals WHERE id = $1`, [reversalId]);
  assert.equal(row.rows[0].status, "reversal_confirmed");
  assert.equal(row.rows[0].provider_reversal_id, "trr_test_reversal_123");
  assert.ok(row.rows[0].confirmed_at);
});

test("REVERSAL IDEMPOTENCY: an existing reversal found via reconciliation is reused, createReversal() is never called", async () => {
  const suffix = crypto.randomBytes(4).toString("hex");
  const entitlementId = await setupTransferredEntitlement(suffix);
  const reversalId = await requestReversal(entitlementId, 20000, "refund");
  await authorizeRefundReversal(entitlementId, reversalId!, 100);

  mockListReversals = async () => ({ data: [{
    id: "trr_already_exists", transfer: "tr_real_transfer_" + suffix,
    amount: 20000, currency: "gbp", metadata: { host_reversal_id: reversalId }
  }], has_more: false });
  let createCalled = false;
  mockCreateReversal = async () => { createCalled = true; return { id: "should_not_be_used" }; };

  const result = await executeReversal(reversalId!);
  assert.equal(result.providerReversalId, "trr_already_exists");
  assert.equal(createCalled, false);
});

test("a Stripe exception requires reconciliation, never falsely confirms or permits automatic retry", async () => {
  const suffix = crypto.randomBytes(4).toString("hex");
  const entitlementId = await setupTransferredEntitlement(suffix);
  const reversalId = await requestReversal(entitlementId, 20000, "refund");
  await authorizeRefundReversal(entitlementId, reversalId!, 100);

  mockListReversals = async () => ({ data: [], has_more: false });
  mockCreateReversal = async () => { throw new Error("Insufficient funds in connected account balance"); };

  const result = await executeReversal(reversalId!);
  assert.equal(result.attempted, true);
  assert.match(result.reason ?? "", /Insufficient/);

  const row = await db.query(`SELECT status, provider_reversal_id FROM host_transfer_reversals WHERE id = $1`, [reversalId]);
  assert.equal(row.rows[0].status, "reversal_reconciliation_required");
  assert.equal(row.rows[0].provider_reversal_id, null, "a failed reversal must never have a provider ID recorded, since none genuinely exists");
});

test("a reversal not in reversal_requested status is refused, no Stripe call made", async () => {
  const suffix = crypto.randomBytes(4).toString("hex");
  const entitlementId = await setupTransferredEntitlement(suffix);
  const reversalId = await requestReversal(entitlementId, 20000, "refund");
  await authorizeRefundReversal(entitlementId, reversalId!, 100);
  await db.query(`UPDATE host_transfer_reversals SET status = 'reversal_confirmed' WHERE id = $1`, [reversalId]);

  let stripeCalled = false;
  mockCreateReversal = async () => { stripeCalled = true; return { id: "x" }; };
  mockListReversals = async () => { stripeCalled = true; return { data: [] }; };

  const result = await executeReversal(reversalId!);
  assert.equal(result.attempted, false);
  assert.equal(stripeCalled, false);
});


const originalReversalExecutionFlag =
  process.env.ENABLE_TRANSFER_REVERSAL_EXECUTION;

beforeEach(() => {
  beforeProviderCall = undefined;
  afterProviderCall = undefined;
  process.env.ENABLE_TRANSFER_REVERSAL_EXECUTION = "true";
  transferRetrieveCalls = 0;
  originalTransferFixtures.clear();
  mockRetrieveTransfer = async (id: string) => {
    const evidence = originalTransferFixtures.get(id);
    if (!evidence) throw new Error("Unexpected original transfer retrieval");
    return { ...evidence, metadata: { ...evidence.metadata } };
  };
});

afterEach(() => {
  if (originalReversalExecutionFlag === undefined) {
    delete process.env.ENABLE_TRANSFER_REVERSAL_EXECUTION;
  } else {
    process.env.ENABLE_TRANSFER_REVERSAL_EXECUTION =
      originalReversalExecutionFlag;
  }
});

test("disabled reversal gate prevents database and Stripe calls", async () => {
  let stripeCalls = 0;
  mockListReversals = async () => {
    stripeCalls++;
    throw new Error("Unexpected Stripe list call");
  };
  mockCreateReversal = async () => {
    stripeCalls++;
    throw new Error("Unexpected Stripe create call");
  };

  const queryMock = mock.method(db, "query", () => {
    throw new Error("Disabled execution must not query the database");
  });

  try {
    for (const value of [undefined, "", "false", "1", "yes", "TRUE", " true", "true "]) {
      if (value === undefined) {
        delete process.env.ENABLE_TRANSFER_REVERSAL_EXECUTION;
      } else {
        process.env.ENABLE_TRANSFER_REVERSAL_EXECUTION = value;
      }

      const result = await executeReversal(crypto.randomUUID());
      assert.equal(result.attempted, false);
      assert.match(result.reason ?? "", /execution is disabled/);
    }
    assert.equal(queryMock.mock.callCount(), 0);
    assert.equal(stripeCalls, 0);
  } finally {
    queryMock.mock.restore();
  }
});

test("other financial gates cannot enable reversal execution", async () => {
  const names = [
    "ENABLE_DELAYED_CHARGE_BOOKINGS",
    "ENABLE_AUTOMATED_OFFSESSION_CHARGING",
    "ENABLE_HOST_TRANSFER_EXECUTION",
  ];
  const originals = names.map(name => process.env[name]);
  delete process.env.ENABLE_TRANSFER_REVERSAL_EXECUTION;

  try {
    for (const name of names) process.env[name] = "true";
    const result = await executeReversal(crypto.randomUUID());
    assert.equal(result.attempted, false);
    assert.match(result.reason ?? "", /execution is disabled/);
  } finally {
    names.forEach((name, index) => {
      if (originals[index] === undefined) delete process.env[name];
      else process.env[name] = originals[index];
    });
  }
});


test("concurrent reversal workers make exactly one Stripe create call", async () => {
  const suffix = crypto.randomBytes(4).toString("hex");
  const entitlementId = await setupTransferredEntitlement(suffix);
  const reversalId = await requestReversal(entitlementId, 20000, "refund");
  await authorizeRefundReversal(entitlementId, reversalId!, 100);
  let createCalls = 0;
  mockListReversals = async () => ({ data: [], has_more: false });
  mockCreateReversal = async () => {
    createCalls++;
    return {
      id: "trr_concurrent_" + suffix, transfer: "tr_real_transfer_" + suffix,
      amount: 20000, currency: "gbp", metadata: { host_reversal_id: reversalId }
    };
  };

  const results = await Promise.all([
    executeReversal(reversalId!),
    executeReversal(reversalId!),
  ]);
  assert.equal(createCalls, 1);
  assert.equal(results.filter(result => result.attempted).length, 1);
});

test("lookup failure blocks reversal creation and subsequent execution", async () => {
  const suffix = crypto.randomBytes(4).toString("hex");
  const entitlementId = await setupTransferredEntitlement(suffix);
  const reversalId = await requestReversal(entitlementId, 20000, "refund");
  await authorizeRefundReversal(entitlementId, reversalId!, 100);
  let listCalls = 0;
  let createCalls = 0;
  mockListReversals = async () => {
    listCalls++;
    throw new Error("Simulated lookup timeout");
  };
  mockCreateReversal = async () => {
    createCalls++;
    throw new Error("Creation must not follow failed lookup");
  };

  const first = await executeReversal(reversalId!);
  assert.equal(first.attempted, true);
  assert.match(first.reason ?? "", /requires reconciliation/);
  const second = await executeReversal(reversalId!);
  assert.equal(second.attempted, false);
  assert.equal(listCalls, 1);
  assert.equal(createCalls, 0);

  const stored = await db.query(
    "SELECT status, provider_reversal_id FROM host_transfer_reversals WHERE id = $1",
    [reversalId]
  );
  assert.equal(stored.rows[0].status, "reversal_reconciliation_required");
  assert.equal(stored.rows[0].provider_reversal_id, null);
});


test("mismatched reversal evidence is never confirmed or automatically retried", async () => {
  for (const mismatch of [
    { id: "invalid_id" },
    { transfer: "tr_wrong_transfer" },
    { amount: 19999 },
    { currency: "eur" },
    { metadata: { host_reversal_id: "wrong_host_record" } },
  ]) {
    const suffix = crypto.randomBytes(4).toString("hex");
    const entitlementId = await setupTransferredEntitlement(suffix);
    const reversalId = await requestReversal(entitlementId, 20000, "refund");
  await authorizeRefundReversal(entitlementId, reversalId!, 100);
    let createCalls = 0;
    mockListReversals = async () => ({ data: [], has_more: false });
    mockCreateReversal = async () => {
      createCalls++;
      return {
        id: "trr_evidence_" + suffix, transfer: "tr_real_transfer_" + suffix,
        amount: 20000, currency: "gbp", metadata: { host_reversal_id: reversalId },
        ...mismatch,
      };
    };

    const result = await executeReversal(reversalId!);
    assert.match(result.reason ?? "", /details mismatch/);
    assert.equal(result.providerReversalId, undefined);
    assert.equal((await executeReversal(reversalId!)).attempted, false);
    assert.equal(createCalls, 1);
    const stored = await db.query(
      "SELECT status, provider_reversal_id FROM host_transfer_reversals WHERE id = $1",
      [reversalId]
    );
    assert.equal(stored.rows[0].status, "reversal_reconciliation_required");
    assert.equal(stored.rows[0].provider_reversal_id, null);
  }
});

test("reconciliation finds a verified reversal on the second page without creation", async () => {
  const suffix = crypto.randomBytes(4).toString("hex");
  const entitlementId = await setupTransferredEntitlement(suffix);
  const reversalId = await requestReversal(entitlementId, 20000, "refund");
  await authorizeRefundReversal(entitlementId, reversalId!, 100);
  const cursors: Array<string | undefined> = [];
  mockListReversals = async (transferId: string, params: any) => {
    assert.equal(transferId, "tr_real_transfer_" + suffix);
    cursors.push(params.starting_after);
    if (!params.starting_after) {
      return { data: [{ id: "trr_first_page", metadata: {} }], has_more: true };
    }
    assert.equal(params.starting_after, "trr_first_page");
    return { data: [{
      id: "trr_second_page", transfer: transferId,
      amount: 20000, currency: "gbp", metadata: { host_reversal_id: reversalId },
    }], has_more: false };
  };
  mockCreateReversal = async () => { throw new Error("Must reuse existing reversal"); };

  const result = await executeReversal(reversalId!);
  assert.equal(result.providerReversalId, "trr_second_page");
  assert.deepEqual(cursors, [undefined, "trr_first_page"]);
});


test("reversal review includes processing and uncertain outcomes without Stripe calls or state changes", async () => {
  const { listTransferReversalsForReview } = await import("./transferReversal");
  const suffix = crypto.randomBytes(4).toString("hex");
  const entitlementId = await setupTransferredEntitlement(suffix);
  const statuses = [
    "reversal_processing",
    "reversal_reconciliation_required",
    "reversal_requested",
    "reversal_confirmed",
  ];
  const ids: string[] = [];
  for (let index = 0; index < statuses.length; index++) {
    const id = await requestReversal(entitlementId, 1000 + index, "refund");
    assert.ok(id);
    ids.push(id!);
    await db.query(
      `UPDATE host_transfer_reversals
       SET status = $2,
           requested_at = (
             SELECT COALESCE(MIN(requested_at), clock_timestamp()) - INTERVAL '1 day'
             FROM host_transfer_reversals
           )
       WHERE id = $1`,
      [id, statuses[index]]
    );
  }

  let stripeCalls = 0;
  mockListReversals = async () => {
    stripeCalls++;
    throw new Error("Review must not contact Stripe");
  };
  mockCreateReversal = async () => {
    stripeCalls++;
    throw new Error("Review must not create reversals");
  };

  const review = await listTransferReversalsForReview(500);
  assert.ok(review.some(row => row.reversal_id === ids[0]));
  assert.ok(review.some(row => row.reversal_id === ids[1]));
  assert.ok(!review.some(row => row.reversal_id === ids[2]));
  assert.ok(!review.some(row => row.reversal_id === ids[3]));
  assert.equal(stripeCalls, 0);

  const stored = await db.query(
    "SELECT id, status FROM host_transfer_reversals WHERE id = ANY($1::uuid[])",
    [ids]
  );
  const records = new Map(stored.rows.map(row => [row.id, row.status]));
  ids.forEach((id, index) => assert.equal(records.get(id), statuses[index]));
});

test("reversal review rejects invalid batch limits before database access", async () => {
  const { listTransferReversalsForReview } = await import("./transferReversal");
  const queryMock = mock.method(db, "query", () => {
    throw new Error("Invalid limit must not query the database");
  });
  try {
    for (const limit of [0, -1, 501, 1.5, NaN, Infinity]) {
      await assert.rejects(listTransferReversalsForReview(limit), /Invalid reversal review limit/);
    }
    assert.equal(queryMock.mock.callCount(), 0);
  } finally {
    queryMock.mock.restore();
  }
});

for (const stage of ["lookup", "creation"]) {
  test("expired reversal lease blocks stale worker at " + stage, async () => {
    const suffix = crypto.randomBytes(8).toString("hex");
    const entitlementId = await setupTransferredEntitlement(suffix);
    const id = await requestReversal(entitlementId, 10000, "refund");
    await authorizeRefundReversal(entitlementId, id!, 50);
    assert.ok(id);
    const expire = async () => {
      await db.query("UPDATE host_transfer_reversals SET execution_lease_expires_at = NOW() - INTERVAL '1 minute' WHERE id = $1", [id]);
    };
    let creates = 0;
    mockListReversals = async () => {
      if (stage === "lookup") await expire();
      return { data: [], has_more: false };
    };
    if (stage === "creation") afterProviderCall = expire;
    mockCreateReversal = async () => {
      creates++;
      return {
        id: "trr_late_" + suffix, transfer: "tr_real_transfer_" + suffix,
        amount: 10000, currency: "gbp", metadata: { host_reversal_id: id }
      };
    };
    const result = await executeReversal(id!);
    assert.equal(result.providerReversalId, undefined);
    assert.equal(creates, stage === "lookup" ? 0 : 1);
    const row = (await db.query("SELECT * FROM host_transfer_reversals WHERE id = $1", [id])).rows[0];
    assert.equal(row.status, "reversal_reconciliation_required");
    assert.equal(row.provider_reversal_id, null);
    assert.equal(row.execution_lease_expires_at, null);
    assert.ok(row.execution_token);
  });
}

for (const mode of ["oversized", "unpaid", "missing_payment", "price_mismatch", "untransferred", "additional_reversal"]) {
  test("reversal financial eligibility refuses " + mode + " before provider access", async () => {
    const suffix = crypto.randomBytes(8).toString("hex");
    const entitlementId = await setupTransferredEntitlement(suffix);
    const id = await requestReversal(entitlementId, mode === "oversized" ? 20001 : 10000, "refund");
    const e = (await db.query("SELECT * FROM host_transfer_entitlements WHERE id = $1", [entitlementId])).rows[0];
    if (mode === "unpaid") await db.query("UPDATE payment_attempts SET status = 'processing' WHERE booking_id = $1", [e.booking_id]);
    if (mode === "missing_payment") await db.query("DELETE FROM payment_attempts WHERE booking_id = $1", [e.booking_id]);
    if (mode === "price_mismatch") await db.query("UPDATE booking_price_components SET host_payout_minor = host_payout_minor + 1 WHERE booking_id = $1", [e.booking_id]);
    if (mode === "untransferred") await db.query("UPDATE host_transfer_entitlements SET status = 'transfer_claimed' WHERE id = $1", [entitlementId]);
    if (mode === "additional_reversal") await requestReversal(entitlementId, 5000, "refund");
    const before = (await db.query("SELECT * FROM host_transfer_reversals WHERE id = $1", [id])).rows[0];
    let calls = 0;
    mockListReversals = async () => { calls++; throw new Error("Unexpected lookup"); };
    mockCreateReversal = async () => { calls++; throw new Error("Unexpected creation"); };
    assert.equal((await executeReversal(id!)).attempted, false);
    assert.equal(calls, 0);
    assert.deepEqual((await db.query("SELECT * FROM host_transfer_reversals WHERE id = $1", [id])).rows[0], before);
  });
}

for (const stage of ["lookup", "creation"]) {
  for (const mode of ["transfer_reference", "price"]) {
    test("changed reversal " + mode + " at " + stage + " blocks completion and replay", async () => {
      const suffix = crypto.randomBytes(8).toString("hex");
      const entitlementId = await setupTransferredEntitlement(suffix);
      const id = await requestReversal(entitlementId, 10000, "refund");
    await authorizeRefundReversal(entitlementId, id!, 50);
      const e = (await db.query("SELECT * FROM host_transfer_entitlements WHERE id = $1", [entitlementId])).rows[0];
      const change = async () => {
        if (mode === "transfer_reference") {
          await db.query("UPDATE host_transfer_entitlements SET provider_transfer_id = $2 WHERE id = $1", [entitlementId, "tr_changed_" + suffix]);
        } else {
          await db.query("UPDATE booking_price_components SET host_payout_minor = host_payout_minor + 1 WHERE booking_id = $1", [e.booking_id]);
        }
      };
      let lists = 0;
      let creates = 0;
      mockListReversals = async () => {
        lists++;
        if (stage === "lookup") await change();
        return { data: [], has_more: false };
      };
      if (stage === "creation") afterProviderCall = change;
      mockCreateReversal = async () => {
        creates++;
        return {
          id: "trr_changed_" + suffix, transfer: e.provider_transfer_id,
          amount: 10000, currency: "gbp", metadata: { host_reversal_id: id },
        };
      };
      const result = await executeReversal(id!);
      assert.equal(result.providerReversalId, undefined);
      assert.equal(creates, stage === "lookup" ? 0 : 1);
      const row = (await db.query("SELECT * FROM host_transfer_reversals WHERE id = $1", [id])).rows[0];
      assert.equal(row.status, "reversal_reconciliation_required");
      assert.equal(row.provider_reversal_id, null);
      assert.ok(row.execution_token);
      assert.equal(row.execution_lease_expires_at, null);
      assert.equal((await executeReversal(id!)).attempted, false);
      assert.equal(lists, 1);
      assert.equal(creates, stage === "lookup" ? 0 : 1);
    });
  }
}

for (const percent of [100, 50]) {
  test("actual paid cancellation authorizes reversal for policy " + percent, async () => {
    const suffix = crypto.randomBytes(8).toString("hex");
    const entitlementId = await setupTransferredEntitlement(suffix);
    const e = (await db.query(
      "SELECT * FROM host_transfer_entitlements WHERE id = $1", [entitlementId]
    )).rows[0];
    await db.query(
      "UPDATE bookings SET cancellation_policy_snapshot = $2::jsonb WHERE id = $1",
      [e.booking_id, JSON.stringify([{ cutoffHours: 0, refundPercent: percent }])]
    );
    const { cancelPaidNewFlowBooking } = await import("../booking/cancelPaidNewFlowBooking");
    const cancellation = await cancelPaidNewFlowBooking({
      bookingId: e.booking_id, cancelledBy: "guest",
    });
    assert.ok(cancellation.reversalId);
    assert.ok(cancellation.refundId);
    const amount = 20000 - cancellation.outcome.hostRetainedMinor;
    let creates = 0;
    mockListReversals = async () => ({ data: [], has_more: false });
    mockCreateReversal = async (transferId: string, params: any) => {
      creates++;
      assert.equal(transferId, e.provider_transfer_id);
      assert.equal(params.amount, amount);
      return {
        id: "trr_cancel_authorized_" + suffix, transfer: transferId,
        amount, currency: "gbp",
        metadata: { host_reversal_id: cancellation.reversalId },
      };
    };
    const result = await executeReversal(cancellation.reversalId!);
    assert.equal(result.providerReversalId, "trr_cancel_authorized_" + suffix);
    assert.equal(creates, 1);
    assert.equal((await db.query(
      "SELECT status FROM new_flow_refunds WHERE id = $1", [cancellation.refundId]
    )).rows[0].status, "pending");
    assert.equal((await executeReversal(cancellation.reversalId!)).attempted, false);
    assert.equal(creates, 1);
  });
}

for (const mode of [
  "missing_audit", "missing_refund", "booking_status", "audit_reversal",
  "audit_refund", "audit_entitlement", "audit_percent", "audit_retained",
  "refund_amount", "refund_currency", "refund_failed", "unsupported_dispute"
]) {
  test("reversal authorization refuses " + mode + " without changes or provider access", async () => {
    const suffix = crypto.randomBytes(8).toString("hex");
    const entitlementId = await setupTransferredEntitlement(suffix);
    const id = await requestReversal(entitlementId, 10000, "refund");
    await authorizeRefundReversal(entitlementId, id!, 50);
    const e = (await db.query("SELECT * FROM host_transfer_entitlements WHERE id = $1", [entitlementId])).rows[0];
    if (mode === "missing_audit") await db.query("DELETE FROM audit_log WHERE object_id = $1", [e.booking_id]);
    if (mode === "missing_refund") await db.query("DELETE FROM new_flow_refunds WHERE booking_id = $1", [e.booking_id]);
    if (mode === "booking_status") await db.query("UPDATE bookings SET status = 'confirmed' WHERE id = $1", [e.booking_id]);
    const auditChanges: Record<string, Record<string, unknown>> = {
      audit_reversal: { reversalId: crypto.randomUUID() },
      audit_refund: { refundId: crypto.randomUUID() },
      audit_entitlement: { entitlementId: crypto.randomUUID() },
      audit_percent: { refundPercent: 100 },
      audit_retained: { hostRetainedMinor: 9999 },
    };
    if (auditChanges[mode]) await db.query(
      "UPDATE audit_log SET new_state = new_state || $2::jsonb WHERE object_id = $1",
      [e.booking_id, JSON.stringify(auditChanges[mode])]
    );
    if (mode === "refund_amount") await db.query("UPDATE new_flow_refunds SET amount_minor = amount_minor + 1 WHERE booking_id = $1", [e.booking_id]);
    if (mode === "refund_currency") await db.query("UPDATE new_flow_refunds SET currency = 'EUR' WHERE booking_id = $1", [e.booking_id]);
    if (mode === "refund_failed") await db.query("UPDATE new_flow_refunds SET status = 'failed' WHERE booking_id = $1", [e.booking_id]);
    if (mode === "unsupported_dispute") await db.query("UPDATE host_transfer_reversals SET reason = 'dispute' WHERE id = $1", [id]);
    const before = (await db.query("SELECT * FROM host_transfer_reversals WHERE id = $1", [id])).rows[0];
    let calls = 0;
    mockListReversals = async () => { calls++; throw new Error("Unexpected lookup"); };
    mockCreateReversal = async () => { calls++; throw new Error("Unexpected creation"); };
    assert.equal((await executeReversal(id!)).attempted, false);
    assert.equal(calls, 0);
    assert.deepEqual((await db.query("SELECT * FROM host_transfer_reversals WHERE id = $1", [id])).rows[0], before);
  });
}

for (const mode of [
  "id", "amount", "currency", "destination", "metadata",
  "reversed", "partial_reversal", "missing_total", "retrieve_error"
]) {
  test("original transfer verification blocks reversal for " + mode, async () => {
    const suffix = crypto.randomBytes(8).toString("hex");
    const entitlementId = await setupTransferredEntitlement(suffix);
    const id = await requestReversal(entitlementId, 10000, "refund");
    await authorizeRefundReversal(entitlementId, id!, 50);
    mockListReversals = async () => ({ data: [], has_more: false });
    mockRetrieveTransfer = async (providerId: string) => {
      if (mode === "retrieve_error") throw new Error("Original transfer unavailable");
      const original = originalTransferFixtures.get(providerId);
      const evidence: any = { ...original, metadata: { ...original.metadata } };
      if (mode === "id") evidence.id = "tr_wrong";
      if (mode === "amount") evidence.amount--;
      if (mode === "currency") evidence.currency = "eur";
      if (mode === "destination") evidence.destination = "acct_wrong";
      if (mode === "metadata") evidence.metadata.host_entitlement_id = crypto.randomUUID();
      if (mode === "reversed") { evidence.reversed = true; evidence.amount_reversed = evidence.amount; }
      if (mode === "partial_reversal") evidence.amount_reversed = 1;
      if (mode === "missing_total") delete evidence.amount_reversed;
      return evidence;
    };
    let creates = 0;
    mockCreateReversal = async () => { creates++; throw new Error("Unexpected creation"); };
    const result = await executeReversal(id!);
    assert.equal(result.providerReversalId, undefined);
    assert.match(result.reason ?? "", /requires reconciliation/);
    assert.equal(transferRetrieveCalls, 1);
    assert.equal(creates, 0);
    const row = (await db.query("SELECT * FROM host_transfer_reversals WHERE id = $1", [id])).rows[0];
    assert.equal(row.status, "reversal_reconciliation_required");
    assert.equal(row.provider_reversal_id, null);
    assert.ok(row.execution_token);
    assert.equal(row.execution_lease_expires_at, null);
    assert.equal((await executeReversal(id!)).attempted, false);
    assert.equal(transferRetrieveCalls, 1);
    assert.equal(creates, 0);
  });
}

for (const stage of ["retrieval", "creation"]) {
  for (const mode of ["audit", "destination"]) {
    test("changed reversal authorization at " + stage + ": " + mode, async () => {
      const suffix = crypto.randomBytes(8).toString("hex");
      const entitlementId = await setupTransferredEntitlement(suffix);
      const id = await requestReversal(entitlementId, 10000, "refund");
      await authorizeRefundReversal(entitlementId, id!, 50);
      const e = (await db.query("SELECT * FROM host_transfer_entitlements WHERE id = $1", [entitlementId])).rows[0];
      const change = async () => {
        if (mode === "audit") {
          await db.query(
            "UPDATE audit_log SET new_state = new_state || $2::jsonb WHERE object_id = $1",
            [e.booking_id, JSON.stringify({ reversalId: crypto.randomUUID() })]
          );
        } else {
          await db.query("UPDATE host_profiles SET stripe_connect_account_id = 'acct_changed' WHERE id = $1", [e.host_id]);
        }
      };
      mockListReversals = async () => ({ data: [], has_more: false });
      mockRetrieveTransfer = async (providerId: string) => {
        const original = originalTransferFixtures.get(providerId);
        const evidence = { ...original, metadata: { ...original.metadata } };
        if (stage === "retrieval") await change();
        return evidence;
      };
      let creates = 0;
      if (stage === "creation") afterProviderCall = change;
      mockCreateReversal = async () => {
        creates++;
        return {
          id: "trr_auth_changed_" + suffix, transfer: e.provider_transfer_id,
          amount: 10000, currency: "gbp", metadata: { host_reversal_id: id },
        };
      };
      const result = await executeReversal(id!);
      assert.equal(result.providerReversalId, undefined);
      assert.equal(creates, stage === "retrieval" ? 0 : 1);
      const row = (await db.query("SELECT * FROM host_transfer_reversals WHERE id = $1", [id])).rows[0];
      assert.equal(row.status, "reversal_reconciliation_required");
      assert.equal(row.provider_reversal_id, null);
      assert.ok(row.execution_token);
      assert.equal(row.execution_lease_expires_at, null);
      assert.equal((await executeReversal(id!)).attempted, false);
      assert.equal(transferRetrieveCalls, 1);
      assert.equal(creates, stage === "retrieval" ? 0 : 1);
    });
  }
}

async function reversalLockFixture() {
  const suffix = crypto.randomBytes(8).toString("hex");
  const entitlementId = await setupTransferredEntitlement(suffix);
  const reversalId = await requestReversal(entitlementId, 10000, "refund");
  assert.ok(reversalId);
  await authorizeRefundReversal(entitlementId, reversalId, 50);
  const executionToken = crypto.randomUUID();
  await db.query(
    "UPDATE host_transfer_reversals SET status = 'reversal_processing', execution_token = $2, execution_lease_expires_at = NOW() + INTERVAL '5 minutes' WHERE id = $1",
    [reversalId, executionToken]
  );
  const e = (await db.query(
    "SELECT * FROM host_transfer_entitlements WHERE id = $1", [entitlementId]
  )).rows[0];
  return {
    reversalId, entitlementId, bookingId: e.booking_id, hostId: e.host_id,
    executionToken, amountMinor: 10000, originalAmountMinor: e.amount_minor,
    currency: e.currency, idempotencyKey: (await db.query(
      "SELECT idempotency_key FROM host_transfer_reversals WHERE id = $1", [reversalId]
    )).rows[0].idempotency_key,
    providerTransferId: e.provider_transfer_id, destination: "acct_test"
  };
}

test("matching reversal authorization invokes provider callback once", async () => {
  const { withTransferReversalProviderLock } = await import("./withTransferReversalProviderLock");
  const expected = await reversalLockFixture();
  let calls = 0;
  assert.equal(await withTransferReversalProviderLock(expected, async () => {
    calls++;
    return "accepted";
  }), "accepted");
  assert.equal(calls, 1);
  const row = (await db.query("SELECT * FROM host_transfer_reversals WHERE id = $1", [expected.reversalId])).rows[0];
  assert.equal(row.status, "reversal_processing");
  assert.equal(row.execution_token, expected.executionToken);
});

for (const mode of [
  "booking", "price", "payment", "entitlement", "reversal",
  "refund", "audit", "destination", "additional_reversal"
]) {
  test("reversal provider window blocks concurrent " + mode + " writes", async () => {
    const { withTransferReversalProviderLock } = await import("./withTransferReversalProviderLock");
    const expected = await reversalLockFixture();
    const other = await db.connect();
    try {
      await withTransferReversalProviderLock(expected, async () => {
        await other.query("BEGIN");
        await other.query("SET LOCAL lock_timeout = '100ms'");
        const queries: Record<string, [string, unknown[]]> = {
          booking: ["UPDATE bookings SET status = 'confirmed' WHERE id = $1", [expected.bookingId]],
          price: ["UPDATE booking_price_components SET host_payout_minor = host_payout_minor + 1 WHERE booking_id = $1", [expected.bookingId]],
          payment: ["UPDATE payment_attempts SET status = 'processing' WHERE booking_id = $1", [expected.bookingId]],
          entitlement: ["UPDATE host_transfer_entitlements SET provider_transfer_id = 'tr_changed' WHERE id = $1", [expected.entitlementId]],
          reversal: ["UPDATE host_transfer_reversals SET amount_minor = amount_minor + 1 WHERE id = $1", [expected.reversalId]],
          refund: ["UPDATE new_flow_refunds SET status = 'failed' WHERE booking_id = $1", [expected.bookingId]],
          audit: ["UPDATE audit_log SET new_state = '{}'::jsonb WHERE object_id = $1", [expected.bookingId]],
          destination: ["UPDATE host_profiles SET stripe_connect_account_id = 'acct_changed' WHERE id = $1", [expected.hostId]],
          additional_reversal: ["INSERT INTO host_transfer_reversals (entitlement_id, amount_minor, reason, status, idempotency_key) VALUES ($1, 1000, 'refund', 'reversal_requested', $2)", [expected.entitlementId, crypto.randomUUID()]],
        };
        const [sql, values] = queries[mode];
        await assert.rejects(other.query(sql, values), (error: any) => error.code === "55P03");
        await other.query("ROLLBACK");
      });
    } finally {
      await other.query("ROLLBACK");
      other.release();
    }
  });
}

for (const mode of ["audit", "refund", "expired_lease", "destination"]) {
  test("changed reversal authorization blocks provider callback: " + mode, async () => {
    const { withTransferReversalProviderLock } = await import("./withTransferReversalProviderLock");
    const expected = await reversalLockFixture();
    if (mode === "audit") await db.query("UPDATE audit_log SET new_state = '{}'::jsonb WHERE object_id = $1", [expected.bookingId]);
    if (mode === "refund") await db.query("UPDATE new_flow_refunds SET status = 'failed' WHERE booking_id = $1", [expected.bookingId]);
    if (mode === "expired_lease") await db.query("UPDATE host_transfer_reversals SET execution_lease_expires_at = NOW() - INTERVAL '1 minute' WHERE id = $1", [expected.reversalId]);
    if (mode === "destination") await db.query("UPDATE host_profiles SET stripe_connect_account_id = 'acct_changed' WHERE id = $1", [expected.hostId]);
    const before = (await db.query("SELECT * FROM host_transfer_reversals WHERE id = $1", [expected.reversalId])).rows[0];
    let calls = 0;
    await assert.rejects(withTransferReversalProviderLock(expected, async () => { calls++; }), /snapshot changed/);
    assert.equal(calls, 0);
    assert.deepEqual((await db.query("SELECT * FROM host_transfer_reversals WHERE id = $1", [expected.reversalId])).rows[0], before);
  });
}

test("reversal provider error releases locks and preserves committed ownership", async () => {
  const { withTransferReversalProviderLock } = await import("./withTransferReversalProviderLock");
  const expected = await reversalLockFixture();
  await assert.rejects(withTransferReversalProviderLock(expected, async () => {
    throw new Error("Simulated reversal timeout");
  }), /Simulated reversal timeout/);
  const other = await db.connect();
  try {
    await other.query("BEGIN");
    await other.query("SET LOCAL lock_timeout = '100ms'");
    await other.query("UPDATE new_flow_refunds SET updated_at = NOW() WHERE booking_id = $1", [expected.bookingId]);
    await other.query("UPDATE audit_log SET new_state = new_state WHERE object_id = $1", [expected.bookingId]);
  } finally {
    await other.query("ROLLBACK");
    other.release();
  }
  const row = (await db.query("SELECT * FROM host_transfer_reversals WHERE id = $1", [expected.reversalId])).rows[0];
  assert.equal(row.status, "reversal_processing");
  assert.equal(row.execution_token, expected.executionToken);
  assert.equal(row.provider_reversal_id, null);
});

async function reversalWorkerFixture() {
  const expected = await reversalLockFixture();
  await db.query(
    "UPDATE host_transfer_reversals SET status = 'reversal_requested', execution_token = NULL, execution_lease_expires_at = NULL WHERE id = $1",
    [expected.reversalId]
  );
  return expected;
}

for (const mode of ["booking", "price", "payment", "entitlement", "reversal", "refund", "audit", "destination"]) {
  test("reversal worker holds authorization locks during creation: " + mode, async () => {
    const expected = await reversalWorkerFixture();
    let creates = 0;
    mockListReversals = async () => ({ data: [], has_more: false });
    mockCreateReversal = async (transferId: string, params: any, options: any) => {
      creates++;
      assert.equal(transferId, expected.providerTransferId);
      assert.equal(params.amount, expected.amountMinor);
      assert.equal(options.idempotencyKey, expected.idempotencyKey);
      assert.equal(options.timeout, 20000);
      assert.equal(options.maxNetworkRetries, 0);
      const other = await db.connect();
      try {
        await other.query("BEGIN");
        await other.query("SET LOCAL lock_timeout = '100ms'");
        const queries: Record<string, [string, string]> = {
          booking: ["UPDATE bookings SET status = 'confirmed' WHERE id = $1", expected.bookingId],
          price: ["UPDATE booking_price_components SET host_payout_minor = host_payout_minor + 1 WHERE booking_id = $1", expected.bookingId],
          payment: ["UPDATE payment_attempts SET status = 'processing' WHERE booking_id = $1", expected.bookingId],
          entitlement: ["UPDATE host_transfer_entitlements SET provider_transfer_id = 'tr_changed' WHERE id = $1", expected.entitlementId],
          reversal: ["UPDATE host_transfer_reversals SET amount_minor = amount_minor + 1 WHERE id = $1", expected.reversalId],
          refund: ["UPDATE new_flow_refunds SET status = 'failed' WHERE booking_id = $1", expected.bookingId],
          audit: ["UPDATE audit_log SET new_state = '{}'::jsonb WHERE object_id = $1", expected.bookingId],
          destination: ["UPDATE host_profiles SET stripe_connect_account_id = 'acct_changed' WHERE id = $1", expected.hostId],
        };
        const [sql, value] = queries[mode];
        await assert.rejects(other.query(sql, [value]), (error: any) => error.code === "55P03");
      } finally {
        await other.query("ROLLBACK");
        other.release();
      }
      return {
        id: "trr_locked_" + crypto.randomBytes(8).toString("hex"),
        transfer: transferId, amount: params.amount, currency: "gbp",
        metadata: { host_reversal_id: expected.reversalId },
      };
    };
    const result = await executeReversal(expected.reversalId);
    assert.ok(result.providerReversalId);
    const row = (await db.query("SELECT * FROM host_transfer_reversals WHERE id = $1", [expected.reversalId])).rows[0];
    assert.equal(row.status, "reversal_confirmed");
    assert.equal(row.provider_reversal_id, result.providerReversalId);
    assert.equal((await executeReversal(expected.reversalId)).attempted, false);
    assert.equal(creates, 1);
  });
}

test("bounded reversal creation timeout blocks replay", async () => {
  const expected = await reversalWorkerFixture();
  let creates = 0;
  let lists = 0;
  mockListReversals = async () => { lists++; return { data: [], has_more: false }; };
  mockCreateReversal = async (_transferId: string, _params: any, options: any) => {
    creates++;
    assert.equal(options.timeout, 20000);
    assert.equal(options.maxNetworkRetries, 0);
    throw new Error("Simulated bounded reversal timeout");
  };
  const result = await executeReversal(expected.reversalId);
  assert.equal(result.providerReversalId, undefined);
  assert.match(result.reason ?? "", /requires reconciliation/);
  const before = (await db.query("SELECT * FROM host_transfer_reversals WHERE id = $1", [expected.reversalId])).rows[0];
  assert.equal(before.status, "reversal_reconciliation_required");
  assert.equal(before.provider_reversal_id, null);
  assert.equal(before.confirmed_at, null);
  assert.ok(before.execution_token);
  assert.equal(before.execution_lease_expires_at, null);
  assert.equal((await executeReversal(expected.reversalId)).attempted, false);
  assert.equal(creates, 1);
  assert.equal(lists, 1);
  assert.equal(transferRetrieveCalls, 1);
  assert.deepEqual((await db.query("SELECT * FROM host_transfer_reversals WHERE id = $1", [expected.reversalId])).rows[0], before);
});

for (const mode of ["audit", "refund", "destination", "price", "expired_lease", "execution_token"]) {
  test("reversal final preflight blocks creation: " + mode, async () => {
    const expected = await reversalWorkerFixture();
    let creates = 0;
    mockListReversals = async () => ({ data: [], has_more: false });
    mockCreateReversal = async () => { creates++; throw new Error("Unexpected creation"); };
    beforeProviderCall = async () => {
      if (mode === "audit") await db.query("UPDATE audit_log SET new_state = '{}'::jsonb WHERE object_id = $1", [expected.bookingId]);
      if (mode === "refund") await db.query("UPDATE new_flow_refunds SET status = 'failed' WHERE booking_id = $1", [expected.bookingId]);
      if (mode === "destination") await db.query("UPDATE host_profiles SET stripe_connect_account_id = 'acct_changed' WHERE id = $1", [expected.hostId]);
      if (mode === "price") await db.query("UPDATE booking_price_components SET host_payout_minor = host_payout_minor + 1 WHERE booking_id = $1", [expected.bookingId]);
      if (mode === "expired_lease") await db.query("UPDATE host_transfer_reversals SET execution_lease_expires_at = NOW() - INTERVAL '1 minute' WHERE id = $1", [expected.reversalId]);
      if (mode === "execution_token") await db.query("UPDATE host_transfer_reversals SET execution_token = $2 WHERE id = $1", [expected.reversalId, crypto.randomUUID()]);
    };
    const result = await executeReversal(expected.reversalId);
    assert.equal(result.providerReversalId, undefined);
    assert.match(result.reason ?? "", /snapshot changed/);
    assert.equal(creates, 0);
    const row = (await db.query("SELECT * FROM host_transfer_reversals WHERE id = $1", [expected.reversalId])).rows[0];
    assert.equal(row.status, mode === "execution_token" ? "reversal_processing" : "reversal_reconciliation_required");
    assert.equal(row.provider_reversal_id, null);
    assert.equal(row.confirmed_at, null);
    assert.equal((await executeReversal(expected.reversalId)).attempted, false);
    assert.equal(creates, 0);
    assert.equal(transferRetrieveCalls, 1);
  });
}

test("reversal worker lock timeout blocks creation and replay", async () => {
  const expected = await reversalWorkerFixture();
  const other = await db.connect();
  let creates = 0;
  mockListReversals = async () => ({ data: [], has_more: false });
  mockCreateReversal = async () => { creates++; throw new Error("Unexpected creation"); };
  beforeProviderCall = async () => {
    await other.query("BEGIN");
    await other.query("SELECT id FROM audit_log WHERE object_id = $1 FOR UPDATE", [expected.bookingId]);
  };
  try {
    const result = await executeReversal(expected.reversalId);
    assert.equal(result.providerReversalId, undefined);
    assert.match(result.reason ?? "", /requires reconciliation/);
    assert.equal(creates, 0);
    const row = (await db.query("SELECT * FROM host_transfer_reversals WHERE id = $1", [expected.reversalId])).rows[0];
    assert.equal(row.status, "reversal_reconciliation_required");
    assert.equal(row.provider_reversal_id, null);
    assert.equal(row.confirmed_at, null);
    assert.ok(row.execution_token);
    assert.equal(row.execution_lease_expires_at, null);
    assert.equal((await executeReversal(expected.reversalId)).attempted, false);
    assert.equal(creates, 0);
    assert.equal(transferRetrieveCalls, 1);
  } finally {
    await other.query("ROLLBACK");
    other.release();
  }
});


for (const mutation of ["update", "delete"] as const) {
  test("reversal execution refuses busy audit: " + mutation, async () => {
    const suffix = crypto.randomBytes(8).toString("hex");
    const entitlementId = await setupTransferredEntitlement(suffix);
    const reversalId = await requestReversal(entitlementId, 10000, "refund");
    assert.ok(reversalId);
    await authorizeRefundReversal(entitlementId, reversalId, 50);
    const bookingId = (await db.query(
      "SELECT booking_id FROM host_transfer_entitlements WHERE id = $1", [entitlementId]
    )).rows[0].booking_id;
    const audit = (await db.query(
      "SELECT id, to_jsonb(a) AS value FROM audit_log a WHERE object_id = $1 AND action = 'booking_cancelled'",
      [bookingId]
    )).rows[0];
    let creations = 0;
    mockListReversals = async () => ({ data: [], has_more: false });
    mockRetrieveTransfer = async (id: string) => originalTransferFixtures.get(id);
    mockCreateReversal = async () => {
      creations++;
      throw new Error("Audit contention must prevent reversal creation");
    };
    const { withBusyAuthorizationAudit } = await import("../testing/withBusyAuthorizationAudit");
    const outcome = await withBusyAuthorizationAudit(
      audit.id, mutation, () => executeReversal(reversalId)
    );
    assert.ifError(outcome.error);
    assert.equal(creations, 0);
    const current = (await db.query(
      "SELECT * FROM host_transfer_reversals WHERE id = $1", [reversalId]
    )).rows[0];
    assert.equal(current.status, "reversal_reconciliation_required");
    assert.equal(current.provider_reversal_id, null);
    assert.equal(current.confirmed_at, null);
    await executeReversal(reversalId);
    assert.equal(creations, 0);
    assert.deepEqual((await db.query(
      "SELECT to_jsonb(a) AS value FROM audit_log a WHERE id = $1", [audit.id]
    )).rows[0].value, audit.value);
  });
}


for (const uncertain of [false, true]) {
  test("selected cancellation runner integrates execution: reversal " + uncertain, async () => {
    const saved = process.env.ENABLE_TRANSFER_REVERSAL_EXECUTION;
    process.env.ENABLE_TRANSFER_REVERSAL_EXECUTION = "true";
    try {
      const suffix = crypto.randomBytes(8).toString("hex");
      const entitlementId = await setupTransferredEntitlement(suffix);
      const id = await requestReversal(entitlementId, 10000, "refund");
      assert.ok(id);
      await authorizeRefundReversal(entitlementId, id, 50);
      await db.query(
        "UPDATE host_transfer_reversals SET requested_at = (SELECT MIN(requested_at) - INTERVAL '1 day' FROM host_transfer_reversals) WHERE id = $1",
        [id]
      );
      let lists = 0, creates = 0;
      mockListReversals = async () => {
        lists++;
        return { data: [], has_more: false };
      };
      mockRetrieveTransfer = async (transferId: string) => {
        const evidence = originalTransferFixtures.get(transferId);
        assert.ok(evidence);
        return evidence;
      };
      const providerId = "trr_selected_" + suffix;
      mockCreateReversal = async () => {
        creates++;
        if (uncertain) throw new Error("Injected selected reversal uncertainty");
        return {
          id: providerId, transfer: "tr_real_transfer_" + suffix,
          amount: 10000, currency: "gbp", metadata: { host_reversal_id: id }
        };
      };

      const { runSelectedCancellationFinancialBatch: run } =
        await import("../payments/runSelectedCancellationFinancialBatch");
      const result = await run("reversal_execute", { limit: 1 });
      assert.deepEqual(result, {
        status: "completed", expiredIds: [],
        results: [{ operation: "reversal_execute", id, status: "dispatched", attempted: true }]
      });
      const row = (await db.query(
        "SELECT * FROM host_transfer_reversals WHERE id = $1", [id]
      )).rows[0];
      assert.equal(row.status, uncertain ? "reversal_reconciliation_required" : "reversal_confirmed");
      assert.equal(row.provider_reversal_id, uncertain ? null : providerId);
      assert.equal(row.execution_lease_expires_at, null);
      if (uncertain) assert.ok(row.execution_token);
      assert.equal(creates, 1);
      assert.equal(JSON.stringify(result).includes("Injected selected"), false);

      const calls = [lists, creates, transferRetrieveCalls];
      const { selectTransferReversalJobs: select } = await import("./selectTransferReversalJobs");
      assert.equal((await select("reversal_execute")).some(job => job.id === id), false);
      assert.equal((await executeReversal(id)).attempted, false);
      assert.deepEqual([lists, creates, transferRetrieveCalls], calls);
      assert.deepEqual((await db.query(
        "SELECT * FROM host_transfer_reversals WHERE id = $1", [id]
      )).rows[0], row);
    } finally {
      if (saved === undefined) delete process.env.ENABLE_TRANSFER_REVERSAL_EXECUTION;
      else process.env.ENABLE_TRANSFER_REVERSAL_EXECUTION = saved;
    }
  });
}

for (const uncertain of [false, true]) {
  test("reversal queue integrates worker: execution " + uncertain, async () => {
    const suffix = crypto.randomBytes(8).toString("hex");
    const entitlementId = await setupTransferredEntitlement(suffix);
    const id = await requestReversal(entitlementId, 10000, "refund");
    assert.ok(id);
    await authorizeRefundReversal(entitlementId, id, 50);
    await db.query(
      "UPDATE host_transfer_reversals SET requested_at = (SELECT MIN(requested_at) - INTERVAL '1 day' FROM host_transfer_reversals) WHERE id = $1",
      [id]
    );
    let lists = 0, creates = 0;
    mockListReversals = async () => {
      lists++;
      return { data: [], has_more: false };
    };
    const providerId = "trr_queue_" + suffix;
    mockCreateReversal = async () => {
      creates++;
      if (uncertain) throw new Error("Injected queue reversal uncertainty");
      return {
        id: providerId, transfer: "tr_real_transfer_" + suffix,
        amount: 10000, currency: "gbp", metadata: { host_reversal_id: id },
      };
    };
    try {
      const { runSelectedCancellationFinancialBatch: run } =
        await import("../payments/runSelectedCancellationFinancialBatch");
      const result = await run("reversal_execute", {limit:1, useReversalQueue:true});
      assert.deepEqual(result.results, [{
        operation:"reversal_execute", id, status:"dispatched", attempted:true,
      }]);
      const row = (await db.query(
        "SELECT * FROM host_transfer_reversals WHERE id = $1", [id]
      )).rows[0];
      assert.equal(row.status, uncertain ? "reversal_reconciliation_required" : "reversal_confirmed");
      assert.equal(row.provider_reversal_id, uncertain ? null : providerId);
      assert.equal(row.execution_lease_expires_at, null);
      if (uncertain) assert.ok(row.execution_token);
      else {
        assert.equal(row.execution_token, null);
        assert.ok(row.confirmed_at);
      }
      const queue = (await db.query(
        "SELECT *, extract(epoch FROM next_review_at-last_reviewed_at)::float AS delay FROM transfer_reversal_queue_reviews WHERE operation = 'reversal_execute' AND reversal_id = $1",
        [id]
      )).rows[0];
      assert.equal(queue.last_outcome, uncertain ? "unresolved" : "resolved");
      assert.equal(queue.review_failures, uncertain ? 1 : 0);
      assert.equal(queue.delay, uncertain ? 60 : 30);
      assert.equal(creates, 1);
      const calls = [lists, creates, transferRetrieveCalls];
      assert.equal((await executeReversal(id)).attempted, false);
      assert.deepEqual([lists, creates, transferRetrieveCalls], calls);
      assert.deepEqual((await db.query(
        "SELECT * FROM host_transfer_reversals WHERE id = $1", [id]
      )).rows[0], row);
    } finally {
      await db.query("DELETE FROM transfer_reversal_queue_reviews WHERE reversal_id = $1", [id]);
    }
  });
}

async function withReversalHeartbeatFixture(
  failCompletion: boolean,
  work: (database: any, client: any) => Promise<void>
) {
  const {Pool} = await import("pg");
  const fs = await import("node:fs");
  const url = new URL(process.env.DATABASE_URL!);
  assert.ok(["localhost", "127.0.0.1", "[::1]", "::1"].includes(url.hostname));
  assert.equal(decodeURIComponent(url.pathname.slice(1)), "host_test");
  const pool = new Pool({
    connectionString: url.toString(), max: 1,
    connectionTimeoutMillis: 5000,
    options: "-c statement_timeout=5000 -c lock_timeout=1000"
  });
  let client: any;
  try {
    client = await pool.connect();
    const identity = (await client.query(
      "SELECT current_database() AS name, host(inet_server_addr()) AS address"
    )).rows[0];
    assert.equal(identity.name, "host_test");
    assert.ok(["127.0.0.1", "::1"].includes(identity.address));
    await client.query(fs.readFileSync(
      "migrations/047_financial_runner_heartbeats.sql", "utf8"
    ).replace("CREATE TABLE financial_runner_heartbeats",
      "CREATE TEMP TABLE financial_runner_heartbeats"));
    assert.equal((await client.query(
      "SELECT c.relnamespace=pg_my_temp_schema() AS temporary " +
      "FROM pg_class c WHERE c.oid='financial_runner_heartbeats'::regclass"
    )).rows[0].temporary, true);
    const database = {
      query: async (sql: string, values: any[]) => {
        if (failCompletion && sql.startsWith("WITH stamp")) {
          throw new Error("Injected heartbeat completion failure");
        }
        return client.query(sql, values);
      }
    };
    await work(database, client);
  } finally {
    if (client) client.release(true);
    await pool.end();
  }
}

for (const failHeartbeat of [false, true])
for (const uncertain of [false, true]) {
  test("monitored runner integrates worker: reversal execution " + uncertain + " heartbeat failure " + failHeartbeat, async () => {
    const suffix = crypto.randomBytes(8).toString("hex");
    const entitlementId = await setupTransferredEntitlement(suffix);
    const id = await requestReversal(entitlementId, 10000, "refund");
    assert.ok(id);
    await authorizeRefundReversal(entitlementId, id, 50);
    await db.query(
      "UPDATE host_transfer_reversals SET requested_at = (SELECT MIN(requested_at) - INTERVAL '1 day' FROM host_transfer_reversals) WHERE id = $1",
      [id]
    );
    let lists = 0, creates = 0;
    mockListReversals = async () => {
      lists++;
      return { data: [], has_more: false };
    };
    const providerId = "trr_queue_" + suffix;
    mockCreateReversal = async () => {
      creates++;
      if (uncertain) throw new Error("Injected queue reversal uncertainty");
      return {
        id: providerId, transfer: "tr_real_transfer_" + suffix,
        amount: 10000, currency: "gbp", metadata: { host_reversal_id: id },
      };
    };
    try {

      const {runMonitoredCancellationFinancialBatch: monitored} =
        await import("../payments/runMonitoredCancellationFinancialBatch");
      const run = async (operation: any, options: any) => {
        let output: any;
        await withReversalHeartbeatFixture(failHeartbeat, async (database, heartbeatClient) => {
          const result = await monitored(database, operation, options);
          assert.equal(result.execution.status, "returned");
          output = result.execution.value;
          assert.equal(result.heartbeat.status,
            failHeartbeat ? "write_failed" : "recorded");
          const heartbeat = (await heartbeatClient.query(
            "SELECT * FROM pg_temp.financial_runner_heartbeats"
          )).rows;
          assert.equal(heartbeat.length, 1);
          assert.equal(heartbeat[0].operation, "reversal_execute");
          assert.equal(heartbeat[0].outcome, failHeartbeat ? "started" : "returned");
          if (failHeartbeat) assert.equal(heartbeat[0].finished_at, null);
          else assert.ok(heartbeat[0].finished_at);
        });
        return output;
      };
      const result = await run("reversal_execute", {limit:1, useReversalQueue:true});
      assert.deepEqual(result.results, [{
        operation:"reversal_execute", id, status:"dispatched", attempted:true,
      }]);
      const row = (await db.query(
        "SELECT * FROM host_transfer_reversals WHERE id = $1", [id]
      )).rows[0];
      assert.equal(row.status, uncertain ? "reversal_reconciliation_required" : "reversal_confirmed");
      assert.equal(row.provider_reversal_id, uncertain ? null : providerId);
      assert.equal(row.execution_lease_expires_at, null);
      if (uncertain) assert.ok(row.execution_token);
      else {
        assert.equal(row.execution_token, null);
        assert.ok(row.confirmed_at);
      }
      const queue = (await db.query(
        "SELECT *, extract(epoch FROM next_review_at-last_reviewed_at)::float AS delay FROM transfer_reversal_queue_reviews WHERE operation = 'reversal_execute' AND reversal_id = $1",
        [id]
      )).rows[0];
      assert.equal(queue.last_outcome, uncertain ? "unresolved" : "resolved");
      assert.equal(queue.review_failures, uncertain ? 1 : 0);
      assert.equal(queue.delay, uncertain ? 60 : 30);
      assert.equal(creates, 1);
      const calls = [lists, creates, transferRetrieveCalls];
      assert.equal((await executeReversal(id)).attempted, false);
      assert.deepEqual([lists, creates, transferRetrieveCalls], calls);
      assert.deepEqual((await db.query(
        "SELECT * FROM host_transfer_reversals WHERE id = $1", [id]
      )).rows[0], row);
    } finally {
      await db.query("DELETE FROM transfer_reversal_queue_reviews WHERE reversal_id = $1", [id]);
    }
  });
}


test("execution gate shutdown before provider creation blocks reversal", async () => {
  const expected = await reversalWorkerFixture();
  let reached = false;
  let creates = 0;
  mockListReversals = async () => ({ data: [], has_more: false });
  mockCreateReversal = async () => {
    creates++;
    return {
      id: "trr_gate_shutdown_" + crypto.randomBytes(8).toString("hex"),
      transfer: expected.providerTransferId,
      amount: expected.amountMinor, currency: "gbp",
      metadata: { host_reversal_id: expected.reversalId },
    };
  };
  beforeProviderCall = async () => {
    reached = true;
    process.env.ENABLE_TRANSFER_REVERSAL_EXECUTION = "false";
  };

  const result = await executeReversal(expected.reversalId);
  assert.equal(reached, true, "Must reach final provider preflight");
  assert.equal(creates, 0, "Disabled execution gate must block reversal creation");
  assert.equal(result.providerReversalId, undefined);
  const row = (await db.query(
    "SELECT status, provider_reversal_id FROM host_transfer_reversals WHERE id = $1",
    [expected.reversalId]
  )).rows[0];
  assert.equal(row.provider_reversal_id, null);
  assert.equal(row.status, "reversal_reconciliation_required");
});
