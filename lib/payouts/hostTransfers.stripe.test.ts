import { test, mock, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import crypto from "crypto";
import { db } from "../db";

function transferEvidence(id: string, entitlementId: string) {
  return {
    id, amount: 20000, currency: "gbp", destination: "acct_test_fake",
    metadata: { host_entitlement_id: entitlementId },
    reversed: false, amount_reversed: 0,
  };
}

let afterProviderCall: (() => Promise<void>) | undefined;
let beforeProviderCall: (() => Promise<void>) | undefined;
beforeEach(() => { afterProviderCall = undefined; beforeProviderCall = undefined; });
let mockCreate: any;
let mockList: any;
let attemptRelease: typeof import("./hostTransfers").attemptRelease;
let createEntitlement: typeof import("./hostTransfers").createEntitlement;
let claimEntitlement: typeof import("./hostTransfers").claimEntitlement;

before(async () => {
  const real = await import("./withHostTransferProviderLock");
  mock.module("./withHostTransferProviderLock", {
    namedExports: {
      transferFinancialEligibility: real.transferFinancialEligibility,
      withHostTransferProviderLock: async (expected: any, execute: any) => {
        const preflight = beforeProviderCall;
        beforeProviderCall = undefined;
        if (preflight) await preflight();
        try {
          return await real.withHostTransferProviderLock(expected, execute);
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
          create: async (...args: any[]) => mockCreate(...args),
          list: async (...args: any[]) => mockList(...args),
        },
      },
    },
  });
  ({ attemptRelease, createEntitlement, claimEntitlement } = await import("./hostTransfers"));

  const check = await db.query(`SELECT COUNT(*) FROM fee_configs WHERE active = TRUE`);
  if (Number(check.rows[0].count) === 0) throw new Error("No active fee_configs row — run scripts/seedFeeConfig.ts first");
});
after(async () => { await db.end(); });

async function setupClaimedEntitlement(suffix: string, connectAccountId: string | null = "acct_test_fake", initiallyClaimed = true) {
  const hostUser = await db.query(`INSERT INTO users (email, password_hash, status) VALUES ($1, 'x', 'active') RETURNING id`, [`b9b-ht-host-${suffix}@test.host`]);
  const hostProfile = await db.query(`INSERT INTO host_profiles (user_id, stripe_connect_account_id, payout_account_status) VALUES ($1, $2, 'active') RETURNING id`, [hostUser.rows[0].id, connectAccountId]);
  const property = await db.query(`INSERT INTO properties (host_id, name, city, currency, nightly_price, max_guests, status) VALUES ($1, 'HT Stripe Test', 'Liverpool', 'GBP', 100, 2, 'published') RETURNING id`, [hostProfile.rows[0].id]);
  const guestUser = await db.query(`INSERT INTO users (email, password_hash, status) VALUES ($1, 'x', 'active') RETURNING id`, [`b9b-ht-guest-${suffix}@test.host`]);
  const booking = await db.query(
    `INSERT INTO bookings (property_id, guest_id, host_id, check_in, check_out, guests, status, guest_name, guest_email, cancellation_policy_snapshot, payment_flow_version)
     VALUES ($1, $2, $3, '2026-12-01', '2026-12-03', 1, 'confirmed', 'HT Guest', 'ht@test.host', '[]', 'separate_charges_delayed_v1') RETURNING id`,
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
    [booking.rows[0].id, "transfer-paid-" + suffix, "pi_transfer_paid_" + suffix]
  );
  const entitlementId = await createEntitlement({ bookingId: booking.rows[0].id, hostId: hostProfile.rows[0].id, amountMinor: 20000, taxAmountMinor: null, currency: "GBP", scheduledReleaseAt: new Date(Date.now() - 3600000) });
  if (initiallyClaimed) await claimEntitlement(entitlementId!, "worker-test");
  return entitlementId as string;
}

test("a real transfer is created and the entitlement is correctly updated", async () => {
  const suffix = crypto.randomBytes(4).toString("hex");
  const entitlementId = await setupClaimedEntitlement(suffix);
  process.env.ENABLE_HOST_TRANSFER_EXECUTION = "true";

  mockList = async () => ({ data: [], has_more: false });
  mockCreate = async () => transferEvidence(`tr_test_created_${suffix}`, entitlementId);

  const result = await attemptRelease(entitlementId);
  assert.equal(result.attempted, true);
  assert.equal(result.providerTransferId, `tr_test_created_${suffix}`);

  const row = await db.query(`SELECT status, provider_transfer_id FROM host_transfer_entitlements WHERE id = $1`, [entitlementId]);
  assert.equal(row.rows[0].status, "transfer_created");
  assert.equal(row.rows[0].provider_transfer_id, `tr_test_created_${suffix}`);

  delete process.env.ENABLE_HOST_TRANSFER_EXECUTION;
});

test("TRANSFER IDEMPOTENCY: an existing transfer found via reconciliation is reused, create() is never called", async () => {
  const suffix = crypto.randomBytes(4).toString("hex");
  const entitlementId = await setupClaimedEntitlement(suffix);
  process.env.ENABLE_HOST_TRANSFER_EXECUTION = "true";

  mockList = async () => ({ data: [transferEvidence(`tr_test_already_exists_${suffix}`, entitlementId)], has_more: false });
  let createCalled = false;
  mockCreate = async () => { createCalled = true; return { id: "should_never_be_used" }; };

  const result = await attemptRelease(entitlementId);
  assert.equal(result.providerTransferId, `tr_test_already_exists_${suffix}`);
  assert.equal(createCalled, false, "create() must never be called when reconciliation finds an existing transfer");

  delete process.env.ENABLE_HOST_TRANSFER_EXECUTION;
});

test("an entitlement not in transfer_claimed status is refused, no Stripe call is made", async () => {
  const suffix = crypto.randomBytes(4).toString("hex");
  const hostUser = await db.query(`INSERT INTO users (email, password_hash, status) VALUES ($1, 'x', 'active') RETURNING id`, [`b9b-ht-unclaimed-host-${suffix}@test.host`]);
  const hostProfile = await db.query(`INSERT INTO host_profiles (user_id, stripe_connect_account_id, payout_account_status) VALUES ($1, 'acct_test', 'active') RETURNING id`, [hostUser.rows[0].id]);
  const property = await db.query(`INSERT INTO properties (host_id, name, city, currency, nightly_price, max_guests, status) VALUES ($1, 'Unclaimed Test', 'Liverpool', 'GBP', 100, 2, 'published') RETURNING id`, [hostProfile.rows[0].id]);
  const guestUser = await db.query(`INSERT INTO users (email, password_hash, status) VALUES ($1, 'x', 'active') RETURNING id`, [`b9b-ht-unclaimed-guest-${suffix}@test.host`]);
  const booking = await db.query(
    `INSERT INTO bookings (property_id, guest_id, host_id, check_in, check_out, guests, status, guest_name, guest_email, cancellation_policy_snapshot)
     VALUES ($1, $2, $3, '2026-12-01', '2026-12-03', 1, 'confirmed', 'Guest', 'g@test.host', '[]') RETURNING id`,
    [property.rows[0].id, guestUser.rows[0].id, hostProfile.rows[0].id]
  );
  const entitlementId = await createEntitlement({ bookingId: booking.rows[0].id, hostId: hostProfile.rows[0].id, amountMinor: 10000, taxAmountMinor: null, currency: "GBP", scheduledReleaseAt: new Date() });
  process.env.ENABLE_HOST_TRANSFER_EXECUTION = "true";

  let stripeCalled = false;
  mockList = async () => { stripeCalled = true; return { data: [], has_more: false }; };
  mockCreate = async () => { stripeCalled = true; return { id: "x" }; };

  const result = await attemptRelease(entitlementId!);
  assert.equal(result.attempted, false);
  assert.match(result.reason ?? "", /not in transfer_claimed status/);
  assert.equal(stripeCalled, false);

  delete process.env.ENABLE_HOST_TRANSFER_EXECUTION;
});

test("an entitlement that already has a provider_transfer_id is refused a second transfer", async () => {
  const suffix = crypto.randomBytes(4).toString("hex");
  const entitlementId = await setupClaimedEntitlement(suffix);
  await db.query(`UPDATE host_transfer_entitlements SET provider_transfer_id = $2 WHERE id = $1`, [entitlementId, `tr_already_set_${suffix}`]);
  process.env.ENABLE_HOST_TRANSFER_EXECUTION = "true";

  let stripeCalled = false;
  mockCreate = async () => { stripeCalled = true; return { id: "x" }; };

  const result = await attemptRelease(entitlementId);
  assert.equal(result.attempted, false);
  assert.match(result.reason ?? "", /already exists/);
  assert.equal(stripeCalled, false);

  delete process.env.ENABLE_HOST_TRANSFER_EXECUTION;
});

test("attemptRelease still correctly no-ops while the flag is off, even with real Stripe logic present now", async () => {
  delete process.env.ENABLE_HOST_TRANSFER_EXECUTION;
  const suffix = crypto.randomBytes(4).toString("hex");
  const entitlementId = await setupClaimedEntitlement(suffix);

  let stripeCalled = false;
  mockCreate = async () => { stripeCalled = true; return { id: "x" }; };
  mockList = async () => { stripeCalled = true; return { data: [], has_more: false }; };

  const result = await attemptRelease(entitlementId);
  assert.equal(result.attempted, false);
  assert.match(result.reason ?? "", /ENABLE_HOST_TRANSFER_EXECUTION/);
  assert.equal(stripeCalled, false, "no Stripe call must ever happen while the flag is off");
});

test("a Stripe exception during transfer creation requires reconciliation, not automatic retry", async () => {
  const suffix = crypto.randomBytes(4).toString("hex");
  const entitlementId = await setupClaimedEntitlement(suffix);
  process.env.ENABLE_HOST_TRANSFER_EXECUTION = "true";

  mockList = async () => ({ data: [], has_more: false });
  mockCreate = async () => { throw new Error("Insufficient available balance"); };

  const result = await attemptRelease(entitlementId);
  assert.equal(result.attempted, true);
  assert.match(result.reason ?? "", /Insufficient/);

  const row = await db.query(`SELECT status FROM host_transfer_entitlements WHERE id = $1`, [entitlementId]);
  assert.equal(row.rows[0].status, "transfer_reconciliation_required");

  delete process.env.ENABLE_HOST_TRANSFER_EXECUTION;
});

test("SAFETY: cancellation after entitlement claim prevents Stripe transfer", async () => {
  const suffix = crypto.randomBytes(4).toString("hex");
  const entitlementId = await setupClaimedEntitlement(suffix);

  await db.query(
    `UPDATE bookings SET status = 'cancelled'
     WHERE id = (
       SELECT booking_id FROM host_transfer_entitlements WHERE id = $1
     )`,
    [entitlementId]
  );

  let stripeCalled = false;
  mockList = async () => {
    stripeCalled = true;
    return { data: [], has_more: false };
  };
  mockCreate = async () => {
    stripeCalled = true;
    return { id: "should_not_be_created" };
  };

  const previousFlag = process.env.ENABLE_HOST_TRANSFER_EXECUTION;
  process.env.ENABLE_HOST_TRANSFER_EXECUTION = "true";

  try {
    const result = await attemptRelease(entitlementId);

    assert.equal(result.attempted, false);
    assert.equal(stripeCalled, false, "Stripe must not be called after cancellation");

    const row = await db.query(
      `SELECT status, provider_transfer_id
       FROM host_transfer_entitlements WHERE id = $1`,
      [entitlementId]
    );

    assert.equal(row.rows[0].provider_transfer_id, null);
    assert.notEqual(row.rows[0].status, "transfer_created");
  } finally {
    if (previousFlag === undefined) {
      delete process.env.ENABLE_HOST_TRANSFER_EXECUTION;
    } else {
      process.env.ENABLE_HOST_TRANSFER_EXECUTION = previousFlag;
    }
  }
});


test("concurrent execution calls create only one Stripe transfer", async () => {
  const suffix = crypto.randomBytes(4).toString("hex");
  const entitlementId = await setupClaimedEntitlement(suffix);
  const previousFlag = process.env.ENABLE_HOST_TRANSFER_EXECUTION;
  process.env.ENABLE_HOST_TRANSFER_EXECUTION = "true";
  let createCalls = 0;
  mockList = async () => ({ data: [], has_more: false });
  mockCreate = async () => {
    createCalls++;
    return transferEvidence("tr_concurrent_" + suffix, entitlementId);
  };
  try {
    const results = await Promise.all([
      attemptRelease(entitlementId),
      attemptRelease(entitlementId),
    ]);
    assert.equal(createCalls, 1);
    assert.equal(results.filter(result => result.attempted).length, 1);
  } finally {
    if (previousFlag === undefined) delete process.env.ENABLE_HOST_TRANSFER_EXECUTION;
    else process.env.ENABLE_HOST_TRANSFER_EXECUTION = previousFlag;
  }
});

test("execution rechecks release time and makes no Stripe call for a future entitlement", async () => {
  const suffix = crypto.randomBytes(4).toString("hex");
  const entitlementId = await setupClaimedEntitlement(suffix);
  await db.query(
    "UPDATE host_transfer_entitlements SET scheduled_release_at = NOW() + INTERVAL '1 day' WHERE id = $1",
    [entitlementId]
  );
  const previousFlag = process.env.ENABLE_HOST_TRANSFER_EXECUTION;
  process.env.ENABLE_HOST_TRANSFER_EXECUTION = "true";
  let stripeCalls = 0;
  mockList = async () => { stripeCalls++; throw new Error("Unexpected lookup"); };
  mockCreate = async () => { stripeCalls++; throw new Error("Unexpected creation"); };
  try {
    assert.equal((await attemptRelease(entitlementId)).attempted, false);
    assert.equal(stripeCalls, 0);
    const stored = await db.query(
      "SELECT status FROM host_transfer_entitlements WHERE id = $1",
      [entitlementId]
    );
    assert.equal(stored.rows[0].status, "transfer_claimed");
  } finally {
    if (previousFlag === undefined) delete process.env.ENABLE_HOST_TRANSFER_EXECUTION;
    else process.env.ENABLE_HOST_TRANSFER_EXECUTION = previousFlag;
  }
});

test("transfer lookup timeout blocks creation and subsequent execution", async () => {
  const suffix = crypto.randomBytes(4).toString("hex");
  const entitlementId = await setupClaimedEntitlement(suffix);
  const previousFlag = process.env.ENABLE_HOST_TRANSFER_EXECUTION;
  process.env.ENABLE_HOST_TRANSFER_EXECUTION = "true";
  let listCalls = 0;
  let createCalls = 0;
  mockList = async () => { listCalls++; throw new Error("Simulated timeout"); };
  mockCreate = async () => { createCalls++; throw new Error("Unexpected creation"); };
  try {
    const result = await attemptRelease(entitlementId);
    assert.match(result.reason ?? "", /requires reconciliation/);
    assert.equal((await attemptRelease(entitlementId)).attempted, false);
    assert.equal(listCalls, 1);
    assert.equal(createCalls, 0);
    const stored = await db.query(
      "SELECT status, provider_transfer_id FROM host_transfer_entitlements WHERE id = $1",
      [entitlementId]
    );
    assert.equal(stored.rows[0].status, "transfer_reconciliation_required");
    assert.equal(stored.rows[0].provider_transfer_id, null);
  } finally {
    if (previousFlag === undefined) delete process.env.ENABLE_HOST_TRANSFER_EXECUTION;
    else process.env.ENABLE_HOST_TRANSFER_EXECUTION = previousFlag;
  }
});


async function withTransferExecutionEnabled(run: () => Promise<void>) {
  const original = process.env.ENABLE_HOST_TRANSFER_EXECUTION;
  process.env.ENABLE_HOST_TRANSFER_EXECUTION = "true";
  try { await run(); }
  finally {
    if (original === undefined) delete process.env.ENABLE_HOST_TRANSFER_EXECUTION;
    else process.env.ENABLE_HOST_TRANSFER_EXECUTION = original;
  }
}

for (const source of ["created", "listed"]) {
  test("mismatched transfer evidence requires reconciliation (" + source + ")", async () => {
    await withTransferExecutionEnabled(async () => {
      const changes: Record<string, any>[] = [
        { id: "invalid" }, { amount: 19999 }, { currency: "eur" },
        { destination: "acct_wrong" }, { reversed: true }, { amount_reversed: 1 },
      ];
      if (source === "created") {
        changes.push({ metadata: { host_entitlement_id: crypto.randomUUID() } });
      }
      for (const change of changes) {
        const suffix = crypto.randomBytes(8).toString("hex");
        const id = await setupClaimedEntitlement(suffix);
        const evidence = { ...transferEvidence("tr_mismatch_" + suffix, id), ...change };
        let creates = 0;
        let lists = 0;
        mockList = async () => {
          lists++;
          return { data: source === "listed" ? [evidence] : [], has_more: false };
        };
        mockCreate = async () => { creates++; return evidence; };
        const result = await attemptRelease(id);
        assert.match(result.reason ?? "", /requires reconciliation/);
        assert.equal(result.providerTransferId, undefined);
        const row = await db.query(
          "SELECT status, provider_transfer_id FROM host_transfer_entitlements WHERE id = $1",
          [id]
        );
        assert.equal(row.rows[0].status, "transfer_reconciliation_required");
        assert.equal(row.rows[0].provider_transfer_id, null);
        assert.equal(creates, source === "created" ? 1 : 0);
        assert.equal((await attemptRelease(id)).attempted, false);
        assert.equal(lists, 1);
        assert.equal(creates, source === "created" ? 1 : 0);
      }
    });
  });
}

test("second-page transfer is verified and reused without creation", async () => {
  await withTransferExecutionEnabled(async () => {
    const suffix = crypto.randomBytes(8).toString("hex");
    const id = await setupClaimedEntitlement(suffix);
    const evidence = {
      ...transferEvidence("tr_page_two_" + suffix, id),
      destination: { id: "acct_test_fake" },
    };
    let lists = 0;
    let creates = 0;
    mockList = async (params: any) => {
      lists++;
      assert.equal(params.destination, "acct_test_fake");
      assert.equal(params.limit, 100);
      if (lists === 1) {
        assert.equal(params.starting_after, undefined);
        return { data: [{ id: "tr_unrelated", metadata: {} }], has_more: true };
      }
      assert.equal(params.starting_after, "tr_unrelated");
      return { data: [evidence], has_more: false };
    };
    mockCreate = async () => { creates++; throw new Error("Unexpected creation"); };
    const result = await attemptRelease(id);
    assert.equal(result.providerTransferId, evidence.id);
    assert.equal(lists, 2);
    assert.equal(creates, 0);
    const row = await db.query(
      "SELECT status, provider_transfer_id FROM host_transfer_entitlements WHERE id = $1", [id]
    );
    assert.equal(row.rows[0].status, "transfer_created");
    assert.equal(row.rows[0].provider_transfer_id, evidence.id);
  });
});

test("duplicate matching transfers across pages block confirmation and creation", async () => {
  await withTransferExecutionEnabled(async () => {
    const suffix = crypto.randomBytes(8).toString("hex");
    const id = await setupClaimedEntitlement(suffix);
    let lists = 0;
    let creates = 0;
    mockList = async () => {
      lists++;
      return {
        data: [transferEvidence("tr_duplicate_" + lists + "_" + suffix, id)],
        has_more: lists === 1,
      };
    };
    mockCreate = async () => { creates++; throw new Error("Unexpected creation"); };
    const result = await attemptRelease(id);
    assert.match(result.reason ?? "", /Duplicate transfers/);
    assert.equal(creates, 0);
    assert.equal(result.providerTransferId, undefined);
    const row = await db.query("SELECT status FROM host_transfer_entitlements WHERE id = $1", [id]);
    assert.equal(row.rows[0].status, "transfer_reconciliation_required");
    assert.equal((await attemptRelease(id)).attempted, false);
    assert.equal(lists, 2);
  });
});

test("incomplete pagination, cursor cycles and later lookup failures cannot authorize creation", async () => {
  await withTransferExecutionEnabled(async () => {
    for (const mode of ["missing_has_more", "empty_next_page", "cursor_cycle", "failure_after_match"]) {
      const suffix = crypto.randomBytes(8).toString("hex");
      const id = await setupClaimedEntitlement(suffix);
      let lists = 0;
      let creates = 0;
      mockList = async () => {
        lists++;
        if (mode === "missing_has_more") return { data: [] };
        if (mode === "empty_next_page") return { data: [], has_more: true };
        if (mode === "cursor_cycle") {
          return { data: [{ id: "tr_repeating_cursor", metadata: {} }], has_more: true };
        }
        if (lists === 1) {
          return { data: [transferEvidence("tr_before_timeout_" + suffix, id)], has_more: true };
        }
        throw new Error("Simulated later-page timeout");
      };
      mockCreate = async () => { creates++; throw new Error("Unexpected creation"); };
      const result = await attemptRelease(id);
      assert.match(result.reason ?? "", /requires reconciliation/);
      assert.equal(result.providerTransferId, undefined);
      assert.equal(creates, 0);
      const row = await db.query(
        "SELECT status, provider_transfer_id FROM host_transfer_entitlements WHERE id = $1", [id]
      );
      assert.equal(row.rows[0].status, "transfer_reconciliation_required");
      assert.equal(row.rows[0].provider_transfer_id, null);
      const callsBeforeRetry = lists;
      assert.equal((await attemptRelease(id)).attempted, false);
      assert.equal(lists, callsBeforeRetry);
      assert.equal(creates, 0);
    }
  });
});

for (const stage of ["lookup", "creation"]) {
  test("expired transfer lease blocks stale worker at " + stage, async () => {
    await withTransferExecutionEnabled(async () => {
      const suffix = crypto.randomBytes(8).toString("hex");
      const id = await setupClaimedEntitlement(suffix);
      const expire = async () => {
        await db.query("UPDATE host_transfer_entitlements SET execution_lease_expires_at = NOW() - INTERVAL '1 minute' WHERE id = $1", [id]);
      };
      let creates = 0;
      mockList = async () => {
        if (stage === "lookup") await expire();
        return { data: [], has_more: false };
      };
      if (stage === "creation") afterProviderCall = expire;
      mockCreate = async () => {
        creates++;
        return transferEvidence("tr_late_" + suffix, id);
      };
      const result = await attemptRelease(id);
      assert.equal(result.providerTransferId, undefined);
      assert.equal(creates, stage === "lookup" ? 0 : 1);
      const row = (await db.query("SELECT * FROM host_transfer_entitlements WHERE id = $1", [id])).rows[0];
      assert.equal(row.status, "transfer_reconciliation_required");
      assert.equal(row.provider_transfer_id, null);
      assert.equal(row.execution_lease_expires_at, null);
      assert.ok(row.execution_token);
    });
  });
}

for (const mode of ["missing_payment", "unpaid", "payment_amount", "price_amount", "inactive_account"]) {
  test("transfer financial eligibility refuses " + mode + " before provider access", async () => {
    await withTransferExecutionEnabled(async () => {
      const suffix = crypto.randomBytes(8).toString("hex");
      const id = await setupClaimedEntitlement(suffix);
      const e = (await db.query("SELECT * FROM host_transfer_entitlements WHERE id = $1", [id])).rows[0];
      if (mode === "missing_payment") await db.query("DELETE FROM payment_attempts WHERE booking_id = $1", [e.booking_id]);
      if (mode === "unpaid") await db.query("UPDATE payment_attempts SET status = 'processing' WHERE booking_id = $1", [e.booking_id]);
      if (mode === "payment_amount") await db.query("UPDATE payment_attempts SET amount_minor = amount_minor + 1 WHERE booking_id = $1", [e.booking_id]);
      if (mode === "price_amount") await db.query("UPDATE booking_price_components SET host_payout_minor = host_payout_minor + 1 WHERE booking_id = $1", [e.booking_id]);
      if (mode === "inactive_account") await db.query("UPDATE host_profiles SET payout_account_status = 'pending' WHERE id = $1", [e.host_id]);
      const before = (await db.query("SELECT * FROM host_transfer_entitlements WHERE id = $1", [id])).rows[0];
      let calls = 0;
      mockList = async () => { calls++; throw new Error("Unexpected lookup"); };
      mockCreate = async () => { calls++; throw new Error("Unexpected creation"); };
      assert.equal((await attemptRelease(id)).attempted, false);
      assert.equal(calls, 0);
      assert.deepEqual((await db.query("SELECT * FROM host_transfer_entitlements WHERE id = $1", [id])).rows[0], before);
    });
  });
}

for (const stage of ["lookup", "creation"]) {
  for (const mode of ["destination", "price"]) {
    test("changed transfer " + mode + " at " + stage + " blocks completion and replay", async () => {
      await withTransferExecutionEnabled(async () => {
        const suffix = crypto.randomBytes(8).toString("hex");
        const id = await setupClaimedEntitlement(suffix);
        const e = (await db.query("SELECT * FROM host_transfer_entitlements WHERE id = $1", [id])).rows[0];
        const change = async () => {
          if (mode === "destination") {
            await db.query("UPDATE host_profiles SET stripe_connect_account_id = 'acct_changed' WHERE id = $1", [e.host_id]);
          } else {
            await db.query("UPDATE booking_price_components SET host_payout_minor = host_payout_minor + 1 WHERE booking_id = $1", [e.booking_id]);
          }
        };
        let lists = 0;
        let creates = 0;
        mockList = async () => {
          lists++;
          if (stage === "lookup") await change();
          return { data: [], has_more: false };
        };
        if (stage === "creation") afterProviderCall = change;
        mockCreate = async () => {
          creates++;
          return transferEvidence("tr_changed_" + suffix, id);
        };
        const result = await attemptRelease(id);
        assert.equal(result.providerTransferId, undefined);
        assert.equal(creates, stage === "lookup" ? 0 : 1);
        const row = (await db.query("SELECT * FROM host_transfer_entitlements WHERE id = $1", [id])).rows[0];
        assert.equal(row.status, "transfer_reconciliation_required");
        assert.equal(row.provider_transfer_id, null);
        assert.ok(row.execution_token);
        assert.equal(row.execution_lease_expires_at, null);
        assert.equal((await attemptRelease(id)).attempted, false);
        assert.equal(lists, 1);
        assert.equal(creates, stage === "lookup" ? 0 : 1);
      });
    });
  }
}

for (const mode of ["booking", "price", "payment", "entitlement", "destination"]) {
  test("transfer worker holds financial locks during creation: " + mode, async () => {
    await withTransferExecutionEnabled(async () => {
      const suffix = crypto.randomBytes(8).toString("hex");
      const id = await setupClaimedEntitlement(suffix);
      const e = (await db.query("SELECT * FROM host_transfer_entitlements WHERE id = $1", [id])).rows[0];
      let creates = 0;
      mockList = async () => ({ data: [], has_more: false });
      mockCreate = async (_params: any, options: any) => {
        creates++;
        assert.equal(options.timeout, 20000);
        assert.equal(options.maxNetworkRetries, 0);
        assert.equal(options.idempotencyKey, e.idempotency_key);
        const other = await db.connect();
        try {
          await other.query("BEGIN");
          await other.query("SET LOCAL lock_timeout = '100ms'");
          const queries: Record<string, [string, string]> = {
            booking: ["UPDATE bookings SET status = 'cancelled' WHERE id = $1", e.booking_id],
            price: ["UPDATE booking_price_components SET host_payout_minor = host_payout_minor + 1 WHERE booking_id = $1", e.booking_id],
            payment: ["UPDATE payment_attempts SET status = 'processing' WHERE booking_id = $1", e.booking_id],
            entitlement: ["UPDATE host_transfer_entitlements SET amount_minor = amount_minor + 1 WHERE id = $1", id],
            destination: ["UPDATE host_profiles SET stripe_connect_account_id = 'acct_changed' WHERE id = $1", e.host_id],
          };
          const [sql, value] = queries[mode];
          await assert.rejects(other.query(sql, [value]), (error: any) => error.code === "55P03");
        } finally {
          await other.query("ROLLBACK");
          other.release();
        }
        return transferEvidence("tr_locked_" + suffix, id);
      };
      const result = await attemptRelease(id);
      assert.equal(result.providerTransferId, "tr_locked_" + suffix);
      assert.equal(creates, 1);
      assert.equal((await attemptRelease(id)).attempted, false);
      assert.equal(creates, 1);
    });
  });
}

test("transfer worker serializes cancellation during provider creation", async () => {
  await withTransferExecutionEnabled(async () => {
    const { cancelPaidNewFlowBooking } = await import("../booking/cancelPaidNewFlowBooking");
    const suffix = crypto.randomBytes(8).toString("hex");
    const id = await setupClaimedEntitlement(suffix);
    const e = (await db.query("SELECT * FROM host_transfer_entitlements WHERE id = $1", [id])).rows[0];
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    let creates = 0;
    mockList = async () => ({ data: [], has_more: false });
    mockCreate = async () => {
      creates++;
      entered();
      await gate;
      throw new Error("Simulated uncertain transfer timeout");
    };
    const worker = attemptRelease(id);
    let cancellation: Promise<unknown> | undefined;
    try {
      await started;
      let settled = false;
      cancellation = cancelPaidNewFlowBooking({
        bookingId: e.booking_id, cancelledBy: "guest"
      }).then(
        value => { settled = true; return { value }; },
        error => { settled = true; return { error }; }
      );
      await new Promise(resolve => setTimeout(resolve, 100));
      assert.equal(settled, false, "cancellation must wait for provider-window locks");
      release();
      const result = await worker;
      assert.match(result.reason ?? "", /requires reconciliation/);
      const cancelled = await cancellation as { error?: Error };
      assert.ok(cancelled.error, "uncertain transfer must prevent cancellation");
      const booking = (await db.query("SELECT status FROM bookings WHERE id = $1", [e.booking_id])).rows[0];
      assert.equal(booking.status, "confirmed");
      const refunds = await db.query("SELECT id FROM new_flow_refunds WHERE booking_id = $1", [e.booking_id]);
      assert.equal(refunds.rows.length, 0);
      assert.equal((await attemptRelease(id)).attempted, false);
      assert.equal(creates, 1);
    } finally {
      release();
      await worker;
      if (cancellation) await cancellation;
    }
  });
});

test("bounded transfer creation timeout blocks replay", async () => {
  await withTransferExecutionEnabled(async () => {
    const suffix = crypto.randomBytes(8).toString("hex");
    const id = await setupClaimedEntitlement(suffix);
    let creates = 0;
    let lists = 0;
    mockList = async () => { lists++; return { data: [], has_more: false }; };
    mockCreate = async (_params: any, options: any) => {
      creates++;
      assert.equal(options.timeout, 20000);
      assert.equal(options.maxNetworkRetries, 0);
      throw new Error("Simulated bounded transfer timeout");
    };
    const result = await attemptRelease(id);
    assert.match(result.reason ?? "", /requires reconciliation/);
    const before = (await db.query("SELECT * FROM host_transfer_entitlements WHERE id = $1", [id])).rows[0];
    assert.equal(before.status, "transfer_reconciliation_required");
    assert.equal(before.provider_transfer_id, null);
    assert.ok(before.execution_token);
    assert.equal(before.execution_lease_expires_at, null);
    assert.equal((await attemptRelease(id)).attempted, false);
    assert.equal(creates, 1);
    assert.equal(lists, 1);
    assert.deepEqual((await db.query("SELECT * FROM host_transfer_entitlements WHERE id = $1", [id])).rows[0], before);
  });
});

for (const mode of ["destination", "price", "payment", "cancelled", "expired_lease", "execution_token"]) {
  test("transfer final preflight blocks creation: " + mode, async () => {
    await withTransferExecutionEnabled(async () => {
      const suffix = crypto.randomBytes(8).toString("hex");
      const id = await setupClaimedEntitlement(suffix);
      const e = (await db.query("SELECT * FROM host_transfer_entitlements WHERE id = $1", [id])).rows[0];
      let creates = 0;
      mockList = async () => ({ data: [], has_more: false });
      mockCreate = async () => { creates++; throw new Error("Unexpected creation"); };
      beforeProviderCall = async () => {
        if (mode === "destination") await db.query("UPDATE host_profiles SET stripe_connect_account_id = 'acct_changed' WHERE id = $1", [e.host_id]);
        if (mode === "price") await db.query("UPDATE booking_price_components SET host_payout_minor = host_payout_minor + 1 WHERE booking_id = $1", [e.booking_id]);
        if (mode === "payment") await db.query("UPDATE payment_attempts SET status = 'processing' WHERE booking_id = $1", [e.booking_id]);
        if (mode === "cancelled") await db.query("UPDATE bookings SET status = 'cancelled' WHERE id = $1", [e.booking_id]);
        if (mode === "expired_lease") await db.query("UPDATE host_transfer_entitlements SET execution_lease_expires_at = NOW() - INTERVAL '1 minute' WHERE id = $1", [id]);
        if (mode === "execution_token") await db.query("UPDATE host_transfer_entitlements SET execution_token = $2 WHERE id = $1", [id, crypto.randomUUID()]);
      };
      const result = await attemptRelease(id);
      assert.equal(result.providerTransferId, undefined);
      assert.match(result.reason ?? "", /snapshot changed/);
      assert.equal(creates, 0);
      const row = (await db.query("SELECT * FROM host_transfer_entitlements WHERE id = $1", [id])).rows[0];
      assert.equal(row.status, mode === "execution_token" ? "transfer_processing" : "transfer_reconciliation_required");
      assert.equal(row.provider_transfer_id, null);
      assert.equal((await attemptRelease(id)).attempted, false);
      assert.equal(creates, 0);
    });
  });
}

test("transfer worker lock timeout blocks creation and replay", async () => {
  await withTransferExecutionEnabled(async () => {
    const suffix = crypto.randomBytes(8).toString("hex");
    const id = await setupClaimedEntitlement(suffix);
    const e = (await db.query("SELECT * FROM host_transfer_entitlements WHERE id = $1", [id])).rows[0];
    const other = await db.connect();
    let creates = 0;
    mockList = async () => ({ data: [], has_more: false });
    mockCreate = async () => { creates++; throw new Error("Unexpected creation"); };
    beforeProviderCall = async () => {
      await other.query("BEGIN");
      await other.query("SELECT booking_id FROM booking_price_components WHERE booking_id = $1 FOR UPDATE", [e.booking_id]);
    };
    try {
      const result = await attemptRelease(id);
      assert.equal(result.providerTransferId, undefined);
      assert.match(result.reason ?? "", /requires reconciliation/);
      assert.equal(creates, 0);
      const row = (await db.query("SELECT * FROM host_transfer_entitlements WHERE id = $1", [id])).rows[0];
      assert.equal(row.status, "transfer_reconciliation_required");
      assert.equal(row.provider_transfer_id, null);
      assert.ok(row.execution_token);
      assert.equal(row.execution_lease_expires_at, null);
      assert.equal((await attemptRelease(id)).attempted, false);
      assert.equal(creates, 0);
    } finally {
      await other.query("ROLLBACK");
      other.release();
    }
  });
});

for (const uncertain of [false, true]) {
  test("selected transfer batch integrates worker: " + (uncertain ? "uncertainty blocks replay" : "success executes once"), async () => {
    const savedFlag = process.env.ENABLE_HOST_TRANSFER_EXECUTION;
    try {
      process.env.ENABLE_HOST_TRANSFER_EXECUTION = "true";
      const suffix = crypto.randomBytes(8).toString("hex");
      const id = await setupClaimedEntitlement(suffix, "acct_test_fake", false);
      await db.query(
        "UPDATE host_transfer_entitlements SET scheduled_release_at = (SELECT MIN(scheduled_release_at) - INTERVAL '1 day' FROM host_transfer_entitlements) WHERE id = $1",
        [id]
      );
      let lists = 0;
      let creates = 0;
      mockList = async () => { lists++; return { data: [], has_more: false }; };
      mockCreate = async () => {
        creates++;
        if (uncertain) throw new Error("Injected selected transfer uncertainty");
        return transferEvidence("tr_selected_" + suffix, id);
      };
      const { runSelectedHostTransferBatch } = await import("./runSelectedHostTransferBatch");
      const { selectClaimableHostTransferIds } = await import("./selectAndClaimHostTransfers");
      const result = await runSelectedHostTransferBatch("selection-integration", { limit: 1 });
      assert.deepEqual(result, [{
        operation: "transfer_execute", id, status: "dispatched", attempted: true
      }]);
      const row = (await db.query(
        "SELECT * FROM host_transfer_entitlements WHERE id = $1", [id]
      )).rows[0];
      assert.equal(row.claimed_by_worker_id, "selection-integration");
      assert.equal(row.status, uncertain ? "transfer_reconciliation_required" : "transfer_created");
      assert.equal(row.provider_transfer_id, uncertain ? null : "tr_selected_" + suffix);
      assert.equal(creates, 1);
      assert.equal(JSON.stringify(result).includes("Injected selected"), false);

      const calls = [lists, creates];
      assert.equal((await selectClaimableHostTransferIds()).includes(id), false);
      assert.equal((await attemptRelease(id)).attempted, false);
      assert.deepEqual([lists, creates], calls);
      assert.deepEqual((await db.query(
        "SELECT * FROM host_transfer_entitlements WHERE id = $1", [id]
      )).rows[0], row);
    } finally {
      if (savedFlag === undefined) delete process.env.ENABLE_HOST_TRANSFER_EXECUTION;
      else process.env.ENABLE_HOST_TRANSFER_EXECUTION = savedFlag;
    }
  });
}

async function rankTransferQueueIntegrationFixture(
  operation: "transfer_execute" | "transfer_reconcile", id: string
) {
  await db.query(
    "WITH ranked AS (SELECT LEAST(clock_timestamp(), (SELECT MIN(scheduled_release_at) FROM host_transfer_entitlements), (SELECT MIN(updated_at) FROM host_transfer_entitlements), (SELECT MIN(next_review_at) FROM host_transfer_queue_reviews)) - INTERVAL '1 day' AS at) INSERT INTO host_transfer_queue_reviews (operation, entitlement_id, review_token, last_reviewed_at, next_review_at, review_failures, last_outcome) SELECT $1, $2, $3, ranked.at - INTERVAL '1 minute', ranked.at, 0, 'selected' FROM ranked WHERE true ON CONFLICT (operation, entitlement_id) DO UPDATE SET review_token = EXCLUDED.review_token, last_reviewed_at = EXCLUDED.last_reviewed_at, next_review_at = EXCLUDED.next_review_at, review_failures = 0, last_outcome = 'selected'",
    [operation, id, crypto.randomUUID()]
  );
}

for (const uncertain of [false, true]) {
  test("transfer queue integrates worker: execution: " + (uncertain ? "uncertainty blocks replay" : "success executes once"), async (t) => {
    const savedFlag = process.env.ENABLE_HOST_TRANSFER_EXECUTION;
    try {
      process.env.ENABLE_HOST_TRANSFER_EXECUTION = "true";
      const suffix = crypto.randomBytes(8).toString("hex");
      const id = await setupClaimedEntitlement(suffix, "acct_test_fake", false);
      t.after(async () => {
        await db.query("DELETE FROM host_transfer_queue_reviews WHERE entitlement_id = $1", [id]);
      });
      await rankTransferQueueIntegrationFixture("transfer_execute", id);
      await db.query(
        "UPDATE host_transfer_entitlements SET scheduled_release_at = (SELECT MIN(scheduled_release_at) - INTERVAL '1 day' FROM host_transfer_entitlements) WHERE id = $1",
        [id]
      );
      let lists = 0;
      let creates = 0;
      mockList = async () => { lists++; return { data: [], has_more: false }; };
      mockCreate = async () => {
        creates++;
        if (uncertain) throw new Error("Injected selected transfer uncertainty");
        return transferEvidence("tr_selected_" + suffix, id);
      };
      const { runSelectedHostTransferBatch } = await import("./runSelectedHostTransferBatch");
      const { selectClaimableHostTransferIds } = await import("./selectAndClaimHostTransfers");
      const result = await runSelectedHostTransferBatch("selection-integration", { limit: 1, useTransferQueue: true });
      assert.deepEqual(result, [{
        operation: "transfer_execute", id, status: "dispatched", attempted: true
      }]);
      const queue = (await db.query(
        "SELECT *, EXTRACT(EPOCH FROM next_review_at - last_reviewed_at)::int AS seconds FROM host_transfer_queue_reviews WHERE operation = $1 AND entitlement_id = $2",
        ["transfer_execute", id]
      )).rows[0];
      assert.equal(queue.last_outcome, !uncertain ? "resolved" : "unresolved");
      assert.equal(queue.review_failures, !uncertain ? 0 : 1);
      assert.equal(queue.seconds, !uncertain ? 30 : 60);
      const row = (await db.query(
        "SELECT * FROM host_transfer_entitlements WHERE id = $1", [id]
      )).rows[0];
      assert.equal(row.claimed_by_worker_id, "selection-integration");
      assert.equal(row.status, uncertain ? "transfer_reconciliation_required" : "transfer_created");
      assert.equal(row.provider_transfer_id, uncertain ? null : "tr_selected_" + suffix);
      assert.equal(creates, 1);
      assert.equal(JSON.stringify(result).includes("Injected selected"), false);

      const calls = [lists, creates];
      assert.equal((await selectClaimableHostTransferIds()).includes(id), false);
      assert.equal((await attemptRelease(id)).attempted, false);
      assert.deepEqual([lists, creates], calls);
      assert.deepEqual((await db.query(
        "SELECT * FROM host_transfer_entitlements WHERE id = $1", [id]
      )).rows[0], row);
    } finally {
      if (savedFlag === undefined) delete process.env.ENABLE_HOST_TRANSFER_EXECUTION;
      else process.env.ENABLE_HOST_TRANSFER_EXECUTION = savedFlag;
    }
  });
}

async function withTransferHeartbeatFixture(
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
  test("monitored runner integrates worker: transfer execution heartbeat failure " + failHeartbeat + ": " + (uncertain ? "uncertainty blocks replay" : "success executes once"), async (t) => {
    const savedFlag = process.env.ENABLE_HOST_TRANSFER_EXECUTION;
    try {
      process.env.ENABLE_HOST_TRANSFER_EXECUTION = "true";
      const suffix = crypto.randomBytes(8).toString("hex");
      const id = await setupClaimedEntitlement(suffix, "acct_test_fake", false);
      t.after(async () => {
        await db.query("DELETE FROM host_transfer_queue_reviews WHERE entitlement_id = $1", [id]);
      });
      await rankTransferQueueIntegrationFixture("transfer_execute", id);
      await db.query(
        "UPDATE host_transfer_entitlements SET scheduled_release_at = (SELECT MIN(scheduled_release_at) - INTERVAL '1 day' FROM host_transfer_entitlements) WHERE id = $1",
        [id]
      );
      let lists = 0;
      let creates = 0;
      mockList = async () => { lists++; return { data: [], has_more: false }; };
      mockCreate = async () => {
        creates++;
        if (uncertain) throw new Error("Injected selected transfer uncertainty");
        return transferEvidence("tr_selected_" + suffix, id);
      };

const {runMonitoredHostTransferExecution: monitored} =
  await import("../payments/runMonitoredHostTransferBatch");
const runSelectedHostTransferBatch = async (workerId: string, options: any) => {

  let output: any;
  await withTransferHeartbeatFixture(failHeartbeat, async (database, heartbeatClient) => {
    const result = await monitored(database, workerId, options);
    assert.equal(result.execution.status, "returned");
    output = result.execution.value;
    assert.equal(result.heartbeat.status,
      failHeartbeat ? "write_failed" : "recorded");
    const rows = (await heartbeatClient.query(
      "SELECT * FROM pg_temp.financial_runner_heartbeats"
    )).rows;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].operation, "transfer_execute");
    assert.equal(rows[0].outcome, failHeartbeat ? "started" : "returned");
    if (failHeartbeat) assert.equal(rows[0].finished_at, null);
    else assert.ok(rows[0].finished_at);
  });
  return output;
};
      const { selectClaimableHostTransferIds } = await import("./selectAndClaimHostTransfers");
      const result = await runSelectedHostTransferBatch("selection-integration", { limit: 1, useTransferQueue: true });
      assert.deepEqual(result, [{
        operation: "transfer_execute", id, status: "dispatched", attempted: true
      }]);
      const queue = (await db.query(
        "SELECT *, EXTRACT(EPOCH FROM next_review_at - last_reviewed_at)::int AS seconds FROM host_transfer_queue_reviews WHERE operation = $1 AND entitlement_id = $2",
        ["transfer_execute", id]
      )).rows[0];
      assert.equal(queue.last_outcome, !uncertain ? "resolved" : "unresolved");
      assert.equal(queue.review_failures, !uncertain ? 0 : 1);
      assert.equal(queue.seconds, !uncertain ? 30 : 60);
      const row = (await db.query(
        "SELECT * FROM host_transfer_entitlements WHERE id = $1", [id]
      )).rows[0];
      assert.equal(row.claimed_by_worker_id, "selection-integration");
      assert.equal(row.status, uncertain ? "transfer_reconciliation_required" : "transfer_created");
      assert.equal(row.provider_transfer_id, uncertain ? null : "tr_selected_" + suffix);
      assert.equal(creates, 1);
      assert.equal(JSON.stringify(result).includes("Injected selected"), false);

      const calls = [lists, creates];
      assert.equal((await selectClaimableHostTransferIds()).includes(id), false);
      assert.equal((await attemptRelease(id)).attempted, false);
      assert.deepEqual([lists, creates], calls);
      assert.deepEqual((await db.query(
        "SELECT * FROM host_transfer_entitlements WHERE id = $1", [id]
      )).rows[0], row);
    } finally {
      if (savedFlag === undefined) delete process.env.ENABLE_HOST_TRANSFER_EXECUTION;
      else process.env.ENABLE_HOST_TRANSFER_EXECUTION = savedFlag;
    }
  });
}


test("execution gate shutdown before provider creation blocks transfer", async () => {
  await withTransferExecutionEnabled(async () => {
    const suffix = crypto.randomBytes(8).toString("hex");
    const id = await setupClaimedEntitlement(suffix);
    let reached = false;
    let creates = 0;
    mockList = async () => ({ data: [], has_more: false });
    mockCreate = async () => {
      creates++;
      return transferEvidence("tr_gate_shutdown_" + suffix, id);
    };
    beforeProviderCall = async () => {
      reached = true;
      process.env.ENABLE_HOST_TRANSFER_EXECUTION = "false";
    };

    const result = await attemptRelease(id);
    assert.equal(reached, true, "Must reach final provider preflight");
    assert.equal(creates, 0, "Disabled execution gate must block transfer creation");
    assert.equal(result.providerTransferId, undefined);
    const row = (await db.query(
      "SELECT status, provider_transfer_id FROM host_transfer_entitlements WHERE id = $1",
      [id]
    )).rows[0];
    assert.equal(row.provider_transfer_id, null);
    assert.equal(row.status, "transfer_reconciliation_required");
  });
});
