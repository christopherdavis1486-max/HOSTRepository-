import { test, mock, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "crypto";
import { db } from "../db";

let mockCustomerCreate: any;
let mockSetupIntentCreate: any;
let mockSetupIntentRetrieve: any;
let createSetupIntentForBooking: typeof import("./setupIntentFlow").createSetupIntentForBooking;
let confirmSetupIntentAndSavePaymentMethod: typeof import("./setupIntentFlow").confirmSetupIntentAndSavePaymentMethod;

before(async () => {
  mock.module("./stripeClient", {
    namedExports: {
      stripe: {
        customers: { create: async (...args: any[]) => mockCustomerCreate(...args) },
        setupIntents: {
          create: async (...args: any[]) => mockSetupIntentCreate(...args),
          retrieve: async (...args: any[]) => mockSetupIntentRetrieve(...args),
        },
      },
    },
  });
  ({ createSetupIntentForBooking, confirmSetupIntentAndSavePaymentMethod } = await import("./setupIntentFlow"));

  const check = await db.query(`SELECT COUNT(*) FROM fee_configs WHERE active = TRUE`);
  if (Number(check.rows[0].count) === 0) throw new Error("No active fee_configs row — run scripts/seedFeeConfig.ts first");
});
after(async () => { await db.end(); });

async function createNewFlowBooking(suffix: string) {
  const hostUser = await db.query(`INSERT INTO users (email, password_hash, status) VALUES ($1, 'x', 'active') RETURNING id`, [`b9b-si-host-${suffix}@test.host`]);
  const hostProfile = await db.query(`INSERT INTO host_profiles (user_id, payout_account_status) VALUES ($1, 'active') RETURNING id`, [hostUser.rows[0].id]);
  const property = await db.query(`INSERT INTO properties (host_id, name, city, currency, nightly_price, max_guests, status) VALUES ($1, 'SI Stripe Test', 'Liverpool', 'GBP', 100, 2, 'published') RETURNING id`, [hostProfile.rows[0].id]);
  const guestUser = await db.query(`INSERT INTO users (email, password_hash, status) VALUES ($1, 'x', 'active') RETURNING id`, [`b9b-si-guest-${suffix}@test.host`]);
  const booking = await db.query(
    `INSERT INTO bookings (property_id, guest_id, host_id, check_in, check_out, guests, status, guest_name, guest_email, cancellation_policy_snapshot, payment_flow_version)
     VALUES ($1, $2, $3, '2027-06-01', '2027-06-03', 1, 'pending_payment', 'SI Guest', 'si@test.host', '[]', 'separate_charges_delayed_v1') RETURNING id`,
    [property.rows[0].id, guestUser.rows[0].id, hostProfile.rows[0].id]
  );
  return booking.rows[0].id as string;
}

function setupResponseFixture(
  bookingId: string, customerId: string, id: string,
  status = "requires_payment_method",
): any {
  return {
    id, object: "setup_intent", status, customer: customerId,
    metadata: { booking_id: bookingId }, usage: "off_session",
    client_secret: id + "_secret_localfixture",
  };
}

test("creates a real Customer and SetupIntent, never a PaymentIntent, never charges anything", async () => {
  const suffix = crypto.randomBytes(4).toString("hex");
  const bookingId = await createNewFlowBooking(suffix);

  let capturedUsage: string | undefined;
  mockCustomerCreate = async () => ({ id: `cus_test_${suffix}` });
  mockSetupIntentCreate = async (params: any) => { capturedUsage = params.usage; return setupResponseFixture(bookingId, "cus_test_" + suffix, "seti_test_" + suffix); };

  const result = await createSetupIntentForBooking(bookingId, "si@test.host", "SI Guest");
  assert.equal(result.customerId, `cus_test_${suffix}`);
  assert.equal(result.setupIntentId, `seti_test_${suffix}`);
  assert.equal(capturedUsage, "off_session", "must be configured for future off-session use, per the architecture");

  const row = await db.query(`SELECT stripe_customer_id, stripe_setup_intent_id FROM bookings WHERE id = $1`, [bookingId]);
  assert.equal(row.rows[0].stripe_customer_id, `cus_test_${suffix}`);
  assert.equal(row.rows[0].stripe_setup_intent_id, `seti_test_${suffix}`);
});

test("a repeat call reuses an existing, still-usable Customer and SetupIntent rather than creating duplicates", async () => {
  const suffix = crypto.randomBytes(4).toString("hex");
  const bookingId = await createNewFlowBooking(suffix);

  let createCallCount = 0;
  mockCustomerCreate = async () => { createCallCount++; return { id: `cus_test_${suffix}` }; };
  mockSetupIntentCreate = async () => { createCallCount++; return setupResponseFixture(bookingId, "cus_test_" + suffix, "seti_test_" + suffix); };
  await createSetupIntentForBooking(bookingId, "si@test.host", "SI Guest");
  assert.equal(createCallCount, 2);

  mockSetupIntentRetrieve = async () => (setupResponseFixture(bookingId, "cus_test_" + suffix, "seti_test_" + suffix));
  await createSetupIntentForBooking(bookingId, "si@test.host", "SI Guest");
  assert.equal(createCallCount, 2, "neither create() call should fire again for an existing, still-usable Customer/SetupIntent");
});

test("payment recovery replaces a terminal SetupIntent with a new idempotency key so Stripe never returns the completed intent again", async () => {
  const suffix = crypto.randomBytes(4).toString("hex");
  const bookingId = await createNewFlowBooking(suffix);
  const oldIntentId = `seti_completed_${suffix}`;
  const newIntentId = `seti_recovery_${suffix}`;
  await db.query(
    `UPDATE bookings SET stripe_customer_id = $2, stripe_setup_intent_id = $3 WHERE id = $1`,
    [bookingId, `cus_test_${suffix}`, oldIntentId]
  );

  mockSetupIntentRetrieve = async () => (setupResponseFixture(bookingId, "cus_test_" + suffix, oldIntentId, "succeeded"));
  let capturedKey: string | undefined;
  mockSetupIntentCreate = async (_params: any, options: any) => {
    capturedKey = options.idempotencyKey;
    return setupResponseFixture(bookingId, "cus_test_" + suffix, newIntentId);
  };

  const result = await createSetupIntentForBooking(bookingId, "si@test.host", "SI Guest");

  assert.equal(result.setupIntentId, newIntentId);
  assert.equal(result.clientSecret, newIntentId + "_secret_localfixture");
  assert.equal(capturedKey, `host-setup-intent-${bookingId}-after-${oldIntentId}`);
  assert.notEqual(capturedKey, `host-setup-intent-${bookingId}`, "a terminal intent must never reuse the original booking-only idempotency key");

  const row = await db.query(`SELECT stripe_setup_intent_id FROM bookings WHERE id = $1`, [bookingId]);
  assert.equal(row.rows[0].stripe_setup_intent_id, newIntentId);
});

test("confirmSetupIntentAndSavePaymentMethod persists the real payment method ID only once genuinely succeeded", async () => {
  const suffix = crypto.randomBytes(4).toString("hex");
  const bookingId = await createNewFlowBooking(suffix);
  await db.query(`UPDATE bookings SET stripe_setup_intent_id = $2 WHERE id = $1`, [bookingId, `seti_confirm_${suffix}`]);

  await db.query(
    "UPDATE bookings SET stripe_customer_id = $2 WHERE id = $1",
    [bookingId, "cus_test_" + suffix]
  );
  mockSetupIntentRetrieve = async (id: string, params: any, options: any) => {
    assert.deepEqual(params, {});
    assert.deepEqual(options, { timeout: 20000, maxNetworkRetries: 0 });
    return {
      id, object: "setup_intent", status: "succeeded",
      customer: "cus_test_" + suffix, payment_method: `pm_test_${suffix}`,
      metadata: { booking_id: bookingId }, usage: "off_session",
    };
  };

  const result = await confirmSetupIntentAndSavePaymentMethod(bookingId);
  assert.equal(result.paymentMethodId, `pm_test_${suffix}`);
  assert.equal(result.paymentMethodChanged, true);

  const row = await db.query(`SELECT stripe_payment_method_id FROM bookings WHERE id = $1`, [bookingId]);
  assert.equal(row.rows[0].stripe_payment_method_id, `pm_test_${suffix}`);
});

test("a replacement payment method clears the retry timestamp once and duplicates preserve a later timestamp", async () => {
  const suffix = crypto.randomBytes(4).toString("hex");
  const bookingId = await createNewFlowBooking(suffix);
  await db.query(
    `UPDATE bookings SET stripe_setup_intent_id = $2, stripe_payment_method_id = $3, next_retry_at = NOW() + INTERVAL '24 hours' WHERE id = $1`,
    [bookingId, `seti_recovery_${suffix}`, `pm_old_${suffix}`]
  );
  await db.query(
    "UPDATE bookings SET stripe_customer_id = $2 WHERE id = $1",
    [bookingId, "cus_test_" + suffix]
  );
  mockSetupIntentRetrieve = async (id: string, params: any, options: any) => {
    assert.deepEqual(params, {});
    assert.deepEqual(options, { timeout: 20000, maxNetworkRetries: 0 });
    return {
      id, object: "setup_intent", status: "succeeded",
      customer: "cus_test_" + suffix, payment_method: `pm_new_${suffix}`,
      metadata: { booking_id: bookingId }, usage: "off_session",
    };
  };

  const first = await confirmSetupIntentAndSavePaymentMethod(bookingId);
  assert.equal(first.paymentMethodChanged, true);
  let row = await db.query(`SELECT stripe_payment_method_id, next_retry_at FROM bookings WHERE id = $1`, [bookingId]);
  assert.equal(row.rows[0].stripe_payment_method_id, `pm_new_${suffix}`);
  assert.equal(row.rows[0].next_retry_at, null, "a replacement card clears the timestamp; charge eligibility remains separately guarded");

  await db.query(`UPDATE bookings SET next_retry_at = NOW() + INTERVAL '24 hours' WHERE id = $1`, [bookingId]);
  const duplicate = await confirmSetupIntentAndSavePaymentMethod(bookingId);
  assert.equal(duplicate.paymentMethodChanged, false);
  row = await db.query(`SELECT next_retry_at FROM bookings WHERE id = $1`, [bookingId]);
  assert.ok(row.rows[0].next_retry_at, "a duplicate webhook must not erase the retry scheduled after the replacement card also fails");
});

test("confirmSetupIntentAndSavePaymentMethod refuses to save anything if the SetupIntent has not actually succeeded", async () => {
  const suffix = crypto.randomBytes(4).toString("hex");
  const bookingId = await createNewFlowBooking(suffix);
  await db.query(`UPDATE bookings SET stripe_setup_intent_id = $2 WHERE id = $1`, [bookingId, `seti_notyet_${suffix}`]);

  await db.query(
    "UPDATE bookings SET stripe_customer_id = $2 WHERE id = $1",
    [bookingId, "cus_test_" + suffix]
  );
  mockSetupIntentRetrieve = async (id: string, params: any, options: any) => {
    assert.deepEqual(params, {});
    assert.deepEqual(options, { timeout: 20000, maxNetworkRetries: 0 });
    return {
      id, object: "setup_intent", status: "requires_action",
      customer: "cus_test_" + suffix, payment_method: null,
      metadata: { booking_id: bookingId }, usage: "off_session",
    };
  };

  await assert.rejects(() => confirmSetupIntentAndSavePaymentMethod(bookingId), /provider evidence mismatch/);

  const row = await db.query(`SELECT stripe_payment_method_id FROM bookings WHERE id = $1`, [bookingId]);
  assert.equal(row.rows[0].stripe_payment_method_id, null);
});


for (const status of ["cancelled", "confirmed", "refunded"]) {
  test("SetupIntent creation guard: refuses booking status " + status, async () => {
    const suffix = crypto.randomBytes(8).toString("hex");
    const bookingId = await createNewFlowBooking(suffix);
    await db.query("UPDATE bookings SET status = $2 WHERE id = $1", [bookingId, status]);
    const before = (await db.query(
      "SELECT * FROM bookings WHERE id = $1", [bookingId]
    )).rows;
    let calls = 0;
    mockCustomerCreate = async () => { calls++; return { id: "cus_guard_" + suffix }; };
    mockSetupIntentCreate = async () => {
      calls++;
      return { id: "seti_guard_" + suffix, client_secret: "fixture_secret" };
    };
    mockSetupIntentRetrieve = async () => {
      calls++;
      throw new Error("Unexpected mocked retrieval");
    };
    const outcome = await createSetupIntentForBooking(bookingId, "fixture@test.host", "Fixture")
      .then(value => ({ value, error: undefined }), error => ({ value: undefined, error }));
    assert.equal(calls, 0, "Ineligible booking must make no provider calls");
    assert.deepEqual((await db.query(
      "SELECT * FROM bookings WHERE id = $1", [bookingId]
    )).rows, before);
    assert.ok(outcome.error instanceof Error, "Creation must be refused");
  });
}

test("SetupIntent creation guard: processing intent cannot be replaced", async () => {
  const suffix = crypto.randomBytes(8).toString("hex");
  const bookingId = await createNewFlowBooking(suffix);
  const setupId = "seti_processing_" + suffix;
  await db.query(
    "UPDATE bookings SET stripe_customer_id = $2, stripe_setup_intent_id = $3 WHERE id = $1",
    [bookingId, "cus_processing_" + suffix, setupId]
  );
  const before = (await db.query(
    "SELECT * FROM bookings WHERE id = $1", [bookingId]
  )).rows;
  let creates = 0;
  let reads = 0;
  mockCustomerCreate = async () => { creates++; return { id: "cus_unexpected" }; };
  mockSetupIntentCreate = async () => {
    creates++;
    return { id: "seti_replacement_" + suffix, client_secret: "fixture_secret" };
  };
  mockSetupIntentRetrieve = async () => {
    reads++;
    return {
      id: setupId, object: "setup_intent", status: "processing",
      customer: "cus_processing_" + suffix,
      metadata: { booking_id: bookingId }, usage: "off_session",
    };
  };
  const outcome = await createSetupIntentForBooking(bookingId, "fixture@test.host", "Fixture")
    .then(value => ({ value, error: undefined }), error => ({ value: undefined, error }));
  assert.equal(reads, 1);
  assert.equal(creates, 0, "Processing does not authorize a replacement SetupIntent");
  assert.deepEqual((await db.query(
    "SELECT * FROM bookings WHERE id = $1", [bookingId]
  )).rows, before);
  assert.ok(outcome.error instanceof Error);
});


for (const change of ["cancelled", "customer", "setup_reference"]) {
  test("SetupIntent creation race: preserves changed " + change, async () => {
    const suffix = crypto.randomBytes(8).toString("hex");
    const bookingId = await createNewFlowBooking(suffix);
    const customerId = "cus_create_race_" + suffix;
    await db.query(
      "UPDATE bookings SET stripe_customer_id = $2 WHERE id = $1",
      [bookingId, customerId]
    );
    let expected: any;
    let creates = 0;
    mockCustomerCreate = async () => { throw new Error("Unexpected customer creation"); };
    mockSetupIntentCreate = async (_params: any, options: any) => {
      creates++;
      assert.equal(options.timeout, 20000);
      assert.equal(options.maxNetworkRetries, 0);
      if (change === "cancelled") {
        await db.query("UPDATE bookings SET status = 'cancelled' WHERE id = $1", [bookingId]);
      } else if (change === "customer") {
        await db.query("UPDATE bookings SET stripe_customer_id = 'cus_changed_during_create' WHERE id = $1", [bookingId]);
      } else {
        await db.query("UPDATE bookings SET stripe_setup_intent_id = $2 WHERE id = $1",
          [bookingId, "seti_changed_" + suffix]);
      }
      expected = (await db.query("SELECT * FROM bookings WHERE id = $1", [bookingId])).rows;
      return setupResponseFixture(bookingId, customerId, "seti_created_" + suffix);
    };
    await assert.rejects(
      createSetupIntentForBooking(bookingId, "fixture@test.host", "Fixture"),
      /ownership changed/
    );
    assert.equal(creates, 1);
    assert.deepEqual((await db.query(
      "SELECT * FROM bookings WHERE id = $1", [bookingId]
    )).rows, expected, "Provider result must not overwrite changed local ownership");
  });
}

test("SetupIntent creation guard: unknown provider status cannot authorize replacement", async () => {
  const suffix = crypto.randomBytes(8).toString("hex");
  const bookingId = await createNewFlowBooking(suffix);
  const setupId = "seti_unknown_" + suffix;
  await db.query(
    "UPDATE bookings SET stripe_customer_id = $2, stripe_setup_intent_id = $3 WHERE id = $1",
    [bookingId, "cus_unknown_" + suffix, setupId]
  );
  const before = (await db.query("SELECT * FROM bookings WHERE id = $1", [bookingId])).rows;
  let creates = 0;
  mockCustomerCreate = async () => { creates++; throw new Error("Unexpected creation"); };
  mockSetupIntentCreate = async () => { creates++; throw new Error("Unexpected creation"); };
  mockSetupIntentRetrieve = async () => ({
    id: setupId, status: "unknown_fixture_status", customer: "cus_unknown_" + suffix,
  });
  await assert.rejects(
    createSetupIntentForBooking(bookingId, "fixture@test.host", "Fixture"),
    /unresolved/
  );
  assert.equal(creates, 0);
  assert.deepEqual((await db.query(
    "SELECT * FROM bookings WHERE id = $1", [bookingId]
  )).rows, before);
});


for (const phase of ["create", "reuse", "replacement"]) {
  for (const mismatch of ["customer", "booking", "secret"]) {
    if (phase === "replacement" && mismatch === "secret") continue;
    test("SetupIntent response evidence: rejects " + phase + " " + mismatch, async () => {
      const suffix = crypto.randomBytes(8).toString("hex");
      const bookingId = await createNewFlowBooking(suffix);
      const customerId = "cus_evidence_" + suffix;
      const storedId = phase === "create" ? null : "seti_stored_" + suffix;
      const createdId = "seti_created_" + suffix;
      await db.query(
        "UPDATE bookings SET stripe_customer_id = $2, stripe_setup_intent_id = $3 WHERE id = $1",
        [bookingId, customerId, storedId]
      );
      const before = (await db.query(
        "SELECT * FROM bookings WHERE id = $1", [bookingId]
      )).rows;
      let creates = 0;
      let reads = 0;
      function evidence(id: string, status = "requires_payment_method"): any {
        return {
          id, object: "setup_intent", status, customer: customerId,
          metadata: { booking_id: bookingId }, usage: "off_session",
          client_secret: id + "_secret_localfixture",
        };
      }
      function corrupt(value: any) {
        if (mismatch === "customer") value.customer = "cus_other_fixture";
        if (mismatch === "booking") value.metadata.booking_id = crypto.randomUUID();
        if (mismatch === "secret") value.client_secret = "seti_other_secret_localfixture";
        return value;
      }
      mockCustomerCreate = async () => { throw new Error("Unexpected customer creation"); };
      mockSetupIntentRetrieve = async () => {
        reads++;
        const value = evidence(storedId!, phase === "replacement" ? "succeeded" : "requires_payment_method");
        return phase === "create" ? value : corrupt(value);
      };
      mockSetupIntentCreate = async () => {
        creates++;
        const value = evidence(createdId);
        return phase === "create" ? corrupt(value) : value;
      };

      const outcome = await createSetupIntentForBooking(bookingId, "fixture@test.host", "Fixture")
        .then(value => ({ value, error: undefined }), error => ({ value: undefined, error }));

      assert.ok(outcome.error instanceof Error,
        "Mismatched provider evidence must be rejected before returning a client secret");
      assert.equal(outcome.value, undefined);
      assert.deepEqual((await db.query(
        "SELECT * FROM bookings WHERE id = $1", [bookingId]
      )).rows, before, "Mismatched evidence must not bind provider references");
      assert.equal(creates, phase === "create" ? 1 : 0,
        "Mismatched retrieval must not authorize replacement creation");
      assert.equal(reads, phase === "create" ? 0 : 1);
    });
  }
}


for (const lost of ["customer", "setup"]) {
  test("SetupIntent uncertain creation: lost " + lost + " response blocks replay", async () => {
    const suffix = crypto.randomBytes(8).toString("hex");
    const bookingId = await createNewFlowBooking(suffix);
    const customerId = "cus_uncertain_" + suffix;
    if (lost === "setup") {
      await db.query("UPDATE bookings SET stripe_customer_id = $2 WHERE id = $1",
        [bookingId, customerId]);
    }
    let customers = 0;
    let setups = 0;
    mockCustomerCreate = async () => {
      customers++;
      throw new Error("fixture lost customer response");
    };
    mockSetupIntentCreate = async () => {
      setups++;
      throw new Error("fixture lost setup response");
    };
    mockSetupIntentRetrieve = async () => {
      throw new Error("Unexpected provider retrieval");
    };

    await assert.rejects(
      createSetupIntentForBooking(bookingId, "fixture@test.host", "Fixture"),
      /fixture lost/
    );
    const firstCustomers = customers;
    const firstSetups = setups;
    const second = await createSetupIntentForBooking(bookingId, "fixture@test.host", "Fixture")
      .then(value => ({ value, error: undefined }), error => ({ value: undefined, error }));

    assert.equal(customers, firstCustomers, "Lost response must not replay customer creation");
    assert.equal(setups, firstSetups, "Lost response must not replay SetupIntent creation");
    assert.ok(second.error instanceof Error);
    const booking = (await db.query(
      "SELECT stripe_customer_id, stripe_setup_intent_id FROM bookings WHERE id = $1",
      [bookingId]
    )).rows[0];
    assert.equal(booking.stripe_setup_intent_id, null);
    assert.equal(booking.stripe_customer_id, lost === "setup" ? customerId : null);
  });
}

test("SetupIntent uncertain creation: failed local save blocks provider replay", async () => {
  const suffix = crypto.randomBytes(8).toString("hex");
  const bookingId = await createNewFlowBooking(suffix);
  const customerId = "cus_save_failure_" + suffix;
  await db.query("UPDATE bookings SET stripe_customer_id = $2 WHERE id = $1",
    [bookingId, customerId]);
  let setups = 0;
  mockCustomerCreate = async () => { throw new Error("Unexpected customer creation"); };
  mockSetupIntentCreate = async () => {
    setups++;
    return setupResponseFixture(bookingId, customerId, "seti_save_failure_" + suffix);
  };
  const connect = db.connect;
  const restorers: (() => void)[] = [];
  let injected = 0;
  (db as any).connect = async function (...args: any[]) {
    const client = await (connect as any).apply(db, args);
    const query = client.query;
    client.query = function (...queryArgs: any[]) {
      if (typeof queryArgs[0] === "string" &&
          queryArgs[0].includes("UPDATE bookings SET stripe_customer_id") &&
          queryArgs[1]?.[0] === bookingId) {
        injected++;
        throw new Error("fixture setup reference save failure");
      }
      return query.apply(client, queryArgs);
    };
    restorers.push(() => { client.query = query; });
    return client;
  };
  try {
    await assert.rejects(
      createSetupIntentForBooking(bookingId, "fixture@test.host", "Fixture"),
      /fixture setup reference save failure/
    );
  } finally {
    db.connect = connect;
    for (const restore of restorers.reverse()) restore();
  }
  assert.equal(injected, 1);
  const second = await createSetupIntentForBooking(bookingId, "fixture@test.host", "Fixture")
    .then(value => ({ value, error: undefined }), error => ({ value: undefined, error }));
  assert.equal(setups, 1, "Provider success followed by save failure must not authorize replay");
  assert.ok(second.error instanceof Error);
  assert.equal((await db.query(
    "SELECT stripe_setup_intent_id FROM bookings WHERE id = $1", [bookingId]
  )).rows[0].stripe_setup_intent_id, null);
});


async function setupReservationFixture() {
  const suffix = crypto.randomBytes(8).toString("hex");
  const bookingId = await createNewFlowBooking(suffix);
  const customerId = "cus_reserved_" + suffix;
  const setupId = "seti_reserved_" + suffix;
  await db.query("UPDATE bookings SET stripe_customer_id = $2 WHERE id = $1",
    [bookingId, customerId]);
  mockCustomerCreate = async () => { throw new Error("Unexpected customer creation"); };
  const response = () => setupResponseFixture(bookingId, customerId, setupId);
  const audits = async () => (await db.query(
    "SELECT * FROM audit_log WHERE object_type = 'booking' AND object_id = $1 AND action IN ('setup_intent_creation_reserved','setup_intent_creation_completed') ORDER BY id",
    [bookingId]
  )).rows;
  return { bookingId, customerId, setupId, response, audits };
}

test("SetupIntent reservation contract: ownership commits before provider creation", async () => {
  const f = await setupReservationFixture();
  const observer = await db.connect();
  let creationId: string | undefined;
  try {
    mockSetupIntentCreate = async (params: any) => {
      const rows = (await observer.query(
        "SELECT id,new_state FROM audit_log WHERE object_id = $1 AND action = 'setup_intent_creation_reserved'",
        [f.bookingId]
      )).rows;
      assert.equal(rows.length, 1, "Independent connection must see committed ownership");
      creationId = rows[0].id;
      assert.equal(params.metadata.host_setup_creation_id, creationId);
      assert.equal(rows[0].new_state.bookingId, f.bookingId);
      assert.equal(rows[0].new_state.customerId, f.customerId);
      assert.equal(rows[0].new_state.setupIntentId, null);
      return f.response();
    };
    const result = await createSetupIntentForBooking(f.bookingId, "fixture@test.host", "Fixture");
    assert.equal(result.setupIntentId, f.setupId);
    const audits = await f.audits();
    const completed = audits.filter(row => row.action === "setup_intent_creation_completed");
    assert.equal(completed.length, 1);
    assert.equal(completed[0].new_state.creationId, creationId);
    assert.equal(completed[0].new_state.setupIntentId, f.setupId);
  } finally {
    observer.release();
  }
});

test("SetupIntent reservation contract: concurrent checkout makes one creation", async () => {
  const f = await setupReservationFixture();
  let entered!: () => void;
  let release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const paused = new Promise<void>(resolve => { release = resolve; });
  let creates = 0;
  mockSetupIntentCreate = async () => {
    creates++;
    entered();
    await paused;
    return f.response();
  };
  mockSetupIntentRetrieve = async () => f.response();
  const settle = (promise: Promise<any>) => promise.then(
    value => ({ value, error: undefined }), error => ({ value: undefined, error })
  );
  const first = settle(createSetupIntentForBooking(f.bookingId, "fixture@test.host", "Fixture"));
  let second: Promise<any> | undefined;
  try {
    await started;
    second = settle(createSetupIntentForBooking(f.bookingId, "fixture@test.host", "Fixture"));
  } finally {
    release();
  }
  const a = await first;
  const b = await second;
  assert.ifError(a.error);
  if (b.error) assert.match(String(b.error), /requires review|creation blocked/);
  else assert.equal(b.value.setupIntentId, f.setupId);
  assert.equal(creates, 1);
  const audits = await f.audits();
  assert.equal(audits.filter(row => row.action === "setup_intent_creation_reserved").length, 1);
  assert.equal(audits.filter(row => row.action === "setup_intent_creation_completed").length, 1);
});

test("SetupIntent reservation contract: completion audit failure rolls back references", async () => {
  const f = await setupReservationFixture();
  let creates = 0;
  mockSetupIntentCreate = async () => { creates++; return f.response(); };
  const connect = db.connect;
  const restorers: (() => void)[] = [];
  let injected = 0;
  (db as any).connect = async function (...args: any[]) {
    const client = await (connect as any).apply(db, args);
    const query = client.query;
    client.query = function (...queryArgs: any[]) {
      if (typeof queryArgs[0] === "string" &&
          queryArgs[0].includes("INSERT INTO audit_log") &&
          queryArgs[0].includes("'setup_intent_creation_completed'") &&
          queryArgs[1]?.[0] === f.bookingId) {
        injected++;
        throw new Error("fixture setup completion audit failure");
      }
      return query.apply(client, queryArgs);
    };
    restorers.push(() => { client.query = query; });
    return client;
  };
  try {
    await assert.rejects(
      createSetupIntentForBooking(f.bookingId, "fixture@test.host", "Fixture"),
      /fixture setup completion audit failure/
    );
  } finally {
    db.connect = connect;
    for (const restore of restorers.reverse()) restore();
  }
  assert.equal(injected, 1);
  assert.equal((await db.query(
    "SELECT stripe_setup_intent_id FROM bookings WHERE id = $1", [f.bookingId]
  )).rows[0].stripe_setup_intent_id, null);
  const audits = await f.audits();
  assert.equal(audits.filter(row => row.action === "setup_intent_creation_reserved").length, 1);
  assert.equal(audits.filter(row => row.action === "setup_intent_creation_completed").length, 0);
  await assert.rejects(
    createSetupIntentForBooking(f.bookingId, "fixture@test.host", "Fixture"),
    /requires review/
  );
  assert.equal(creates, 1);
});


for (const mutation of ["missing", "changed_snapshot", "already_completed", "additional_reservation"]) {
  test("SetupIntent completion integrity: rejects " + mutation, async () => {
    const f = await setupReservationFixture();
    let creates = 0;
    let reservationId: string | undefined;
    mockSetupIntentCreate = async () => {
      creates++;
      const reservations = (await f.audits()).filter(
        row => row.action === "setup_intent_creation_reserved"
      );
      assert.equal(reservations.length, 1);
      reservationId = reservations[0].id;

      if (mutation === "missing") {
        await db.query("DELETE FROM audit_log WHERE id = $1", [reservationId]);
      } else if (mutation === "changed_snapshot") {
        await db.query(
          "UPDATE audit_log SET new_state = jsonb_set(new_state, '{customerId}', to_jsonb($2::text)) WHERE id = $1",
          [reservationId, "cus_changed_reservation"]
        );
      } else if (mutation === "already_completed") {
        await db.query(
          "INSERT INTO audit_log (action,object_type,object_id,new_state) VALUES ('setup_intent_creation_completed','booking',$1,$2::jsonb)",
          [f.bookingId, JSON.stringify({
            creationId: reservationId,
            customerId: f.customerId,
            setupIntentId: "seti_other_completion",
          })]
        );
      } else {
        await db.query(
          "INSERT INTO audit_log (action,object_type,object_id,new_state) VALUES ('setup_intent_creation_reserved','booking',$1,$2::jsonb)",
          [f.bookingId, JSON.stringify({
            bookingId: f.bookingId,
            customerId: f.customerId,
            setupIntentId: null,
          })]
        );
      }
      return f.response();
    };

    await assert.rejects(
      createSetupIntentForBooking(f.bookingId, "fixture@test.host", "Fixture"),
      /reservation|ownership|requires review/i,
      "Changed reservation evidence must prevent reference recording"
    );
    assert.equal(creates, 1);
    const booking = (await db.query(
      "SELECT stripe_customer_id,stripe_setup_intent_id FROM bookings WHERE id = $1",
      [f.bookingId]
    )).rows[0];
    assert.equal(booking.stripe_customer_id, f.customerId);
    assert.equal(booking.stripe_setup_intent_id, null);

    const completions = (await f.audits()).filter(
      row => row.action === "setup_intent_creation_completed"
    );
    assert.equal(completions.length, mutation === "already_completed" ? 1 : 0);
  });
}


test("SetupIntent completed reservation: permits verified payment method saving", async () => {
  const f = await setupReservationFixture();
  mockSetupIntentCreate = async () => f.response();
  await createSetupIntentForBooking(f.bookingId, "fixture@test.host", "Fixture");

  const before = await f.audits();
  assert.equal(before.filter(row => row.action === "setup_intent_creation_reserved").length, 1);
  assert.equal(before.filter(row => row.action === "setup_intent_creation_completed").length, 1);

  const paymentMethodId = "pm_completed_" + crypto.randomBytes(8).toString("hex");
  mockSetupIntentRetrieve = async () => ({
    ...f.response(), status: "succeeded", payment_method: paymentMethodId,
  });
  const result = await confirmSetupIntentAndSavePaymentMethod(f.bookingId, f.setupId);
  assert.equal(result.paymentMethodId, paymentMethodId);
  assert.equal(result.paymentMethodChanged, true);
  assert.equal((await db.query(
    "SELECT stripe_payment_method_id FROM bookings WHERE id = $1", [f.bookingId]
  )).rows[0].stripe_payment_method_id, paymentMethodId);
  assert.deepEqual(await f.audits(), before, "Confirmation must not rewrite creation history");
});


async function setupReferenceRecoveryFixture() {
  const f = await setupReservationFixture();
  const reserved = await db.query(
    "INSERT INTO audit_log (action,object_type,object_id,new_state) VALUES ('setup_intent_creation_reserved','booking',$1,$2::jsonb) RETURNING id",
    [f.bookingId, JSON.stringify({
      bookingId: f.bookingId, customerId: f.customerId, setupIntentId: null,
    })]
  );
  const input = {
    bookingId: f.bookingId, customerId: f.customerId,
    creationId: reserved.rows[0].id as string, providerIntentId: f.setupId,
  };
  mockCustomerCreate = mockSetupIntentCreate = async () => {
    throw new Error("Recovery must not create provider resources");
  };
  const evidence = (status = "requires_payment_method") => ({
    ...f.response(), status, livemode: false,
    payment_method: status === "succeeded" ? "pm_recovered_fixture" : null,
    metadata: {
      booking_id: f.bookingId, host_setup_creation_id: input.creationId,
    },
  });
  const booking = async () => (await db.query(
    "SELECT * FROM bookings WHERE id = $1", [f.bookingId]
  )).rows[0];
  const history = async () => (await db.query(
    "SELECT * FROM audit_log WHERE object_type = 'booking' AND object_id = $1 ORDER BY id",
    [f.bookingId]
  )).rows;
  return { ...f, input, evidence, booking, history };
}

for (const status of [
  "requires_payment_method", "requires_confirmation", "requires_action",
  "processing", "succeeded", "canceled",
]) {
  test("Setup reference recovery: retains unresolved ownership for " + status, async () => {
    const { recoverSetupIntentReference } = await import("./recoverSetupIntentReference");
    const f = await setupReferenceRecoveryFixture();
    const before = await f.booking();
    let retrieves = 0;
    mockSetupIntentRetrieve = async (id: string, params: any, options: any) => {
      retrieves++;
      assert.equal(id, f.setupId);
      assert.deepEqual(params, {});
      assert.deepEqual(options, { timeout: 20000, maxNetworkRetries: 0 });
      return f.evidence(status);
    };
    assert.deepEqual(await recoverSetupIntentReference(f.input, () => true),
      { recorded: true });
    const after = await f.booking();
    assert.equal(after.stripe_setup_intent_id, f.setupId);
    const { stripe_setup_intent_id: oldReference, updated_at: oldUpdated, ...oldRest } = before;
    const { stripe_setup_intent_id: newReference, updated_at: newUpdated, ...newRest } = after;
    assert.deepEqual(newRest, oldRest, "Only the setup reference and update timestamp may change");
    const history = await f.history();
    assert.equal(history.filter(row => row.action === "setup_intent_creation_reserved").length, 1);
    assert.equal(history.filter(row => row.action === "setup_intent_creation_completed").length, 0);
    assert.equal(history.filter(row => row.action === "setup_intent_reference_recovered").length, 1);

    assert.deepEqual(await recoverSetupIntentReference(f.input, () => true),
      { recorded: false });
    assert.deepEqual(await f.history(), history);
    assert.deepEqual(await f.booking(), after);
    await assert.rejects(
      createSetupIntentForBooking(f.bookingId, "fixture@test.host", "Fixture"),
      /requires review/
    );
    await assert.rejects(
      confirmSetupIntentAndSavePaymentMethod(f.bookingId, f.setupId),
      /requires review/
    );
    assert.equal(retrieves, 2, "Blocked checkout and confirmation must not retrieve again");
    assert.equal(Number((await db.query(
      "SELECT COUNT(*) FROM payment_attempts WHERE booking_id = $1", [f.bookingId]
    )).rows[0].count), 0);
  });
}

for (const mismatch of ["customer", "creation", "live", "provider_id"]) {
  test("Setup reference recovery: rejects " + mismatch, async () => {
    const { recoverSetupIntentReference } = await import("./recoverSetupIntentReference");
    const f = await setupReferenceRecoveryFixture();
    const before = await f.booking();
    const history = await f.history();
    mockSetupIntentRetrieve = async () => {
      const value = f.evidence();
      if (mismatch === "customer") value.customer = "cus_other";
      if (mismatch === "creation") value.metadata.host_setup_creation_id = crypto.randomUUID();
      if (mismatch === "live") value.livemode = true;
      if (mismatch === "provider_id") value.id = "seti_other";
      return value;
    };
    await assert.rejects(recoverSetupIntentReference(f.input, () => true),
      /provider evidence mismatch/);
    assert.deepEqual(await f.booking(), before);
    assert.deepEqual(await f.history(), history);
  });
}

test("Setup reference recovery: default disabled prevents provider access", async () => {
  const { recoverSetupIntentReference } = await import("./recoverSetupIntentReference");
  const f = await setupReferenceRecoveryFixture();
  const before = await f.booking();
  const history = await f.history();
  mockSetupIntentRetrieve = async () => { throw new Error("Unexpected retrieval"); };
  assert.deepEqual(await recoverSetupIntentReference(f.input), { recorded: false });
  assert.deepEqual(await f.booking(), before);
  assert.deepEqual(await f.history(), history);
});

test("Setup reference recovery: gate shutdown during retrieval prevents recording", async () => {
  const { recoverSetupIntentReference } = await import("./recoverSetupIntentReference");
  const f = await setupReferenceRecoveryFixture();
  const before = await f.booking();
  const history = await f.history();
  let enabled = true;
  mockSetupIntentRetrieve = async () => {
    enabled = false;
    return f.evidence();
  };
  assert.deepEqual(await recoverSetupIntentReference(f.input, () => enabled),
    { recorded: false });
  assert.deepEqual(await f.booking(), before);
  assert.deepEqual(await f.history(), history);
});

test("Setup reference recovery: retrieval failure retains reservation", async () => {
  const { recoverSetupIntentReference } = await import("./recoverSetupIntentReference");
  const f = await setupReferenceRecoveryFixture();
  const before = await f.booking();
  const history = await f.history();
  mockSetupIntentRetrieve = async () => { throw new Error("fixture retrieval timeout"); };
  await assert.rejects(recoverSetupIntentReference(f.input, () => true),
    /fixture retrieval timeout/);
  assert.deepEqual(await f.booking(), before);
  assert.deepEqual(await f.history(), history);
});


test("Setup reference recovery: audit failure rolls back reference", async () => {
  const { recoverSetupIntentReference } = await import("./recoverSetupIntentReference");
  const f = await setupReferenceRecoveryFixture();
  const before = await f.booking();
  const history = await f.history();
  mockSetupIntentRetrieve = async () => f.evidence();
  const connect = db.connect;
  const restorers: (() => void)[] = [];
  let injected = 0;
  (db as any).connect = async function (...args: any[]) {
    const client = await (connect as any).apply(db, args);
    const query = client.query;
    client.query = function (...queryArgs: any[]) {
      if (typeof queryArgs[0] === "string" &&
          queryArgs[0].includes("INSERT INTO audit_log") &&
          queryArgs[0].includes("'setup_intent_reference_recovered'") &&
          queryArgs[1]?.[0] === f.bookingId) {
        injected++;
        throw new Error("fixture setup recovery audit failure");
      }
      return query.apply(client, queryArgs);
    };
    restorers.push(() => { client.query = query; });
    return client;
  };
  try {
    await assert.rejects(recoverSetupIntentReference(f.input, () => true),
      /fixture setup recovery audit failure/);
  } finally {
    db.connect = connect;
    for (const restore of restorers.reverse()) restore();
  }
  assert.equal(injected, 1);
  assert.deepEqual(await f.booking(), before);
  assert.deepEqual(await f.history(), history);
  assert.deepEqual(await recoverSetupIntentReference(f.input, () => true),
    { recorded: true }, "Rolled-back recovery must permit a verified recovery retry");
});

test("Setup reference recovery: concurrent calls record one reference and audit", async () => {
  const { recoverSetupIntentReference } = await import("./recoverSetupIntentReference");
  const f = await setupReferenceRecoveryFixture();
  let entered!: () => void;
  let release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const paused = new Promise<void>(resolve => { release = resolve; });
  let retrieves = 0;
  mockSetupIntentRetrieve = async () => {
    retrieves++;
    if (retrieves === 1) {
      entered();
      await paused;
    }
    return f.evidence();
  };
  const first = recoverSetupIntentReference(f.input, () => true);
  await started;
  const second = recoverSetupIntentReference(f.input, () => true);
  release();
  const results = await Promise.all([first, second]);
  assert.equal(results.filter(result => result.recorded).length, 1);
  assert.equal((await f.booking()).stripe_setup_intent_id, f.setupId);
  const history = await f.history();
  assert.equal(history.filter(row => row.action === "setup_intent_reference_recovered").length, 1);
  assert.equal(history.filter(row => row.action === "setup_intent_creation_reserved").length, 1);
  assert.equal(history.filter(row => row.action === "setup_intent_creation_completed").length, 0);
});


for (const change of [
  "missing_reservation", "changed_customer", "previous_setup",
  "duplicate_reservation", "completed_reservation", "cancelled",
  "archived", "saved_method", "payment_attempt", "unaudited_reference",
]) {
  test("Setup recovery eligibility: refuses " + change, async () => {
    const { recoverSetupIntentReference } = await import("./recoverSetupIntentReference");
    const f = await setupReferenceRecoveryFixture();

    if (change === "missing_reservation") {
      await db.query("DELETE FROM audit_log WHERE id = $1", [f.input.creationId]);
    } else if (change === "changed_customer") {
      await db.query("UPDATE bookings SET stripe_customer_id = 'cus_changed' WHERE id = $1",
        [f.bookingId]);
    } else if (change === "previous_setup") {
      await db.query(
        "UPDATE audit_log SET new_state = jsonb_set(new_state, '{setupIntentId}', to_jsonb('seti_previous'::text)) WHERE id = $1",
        [f.input.creationId]
      );
    } else if (change === "duplicate_reservation") {
      await db.query(
        "INSERT INTO audit_log (action,object_type,object_id,new_state) SELECT action,object_type,object_id,new_state FROM audit_log WHERE id = $1",
        [f.input.creationId]
      );
    } else if (change === "completed_reservation") {
      await db.query(
        "INSERT INTO audit_log (action,object_type,object_id,new_state) VALUES ('setup_intent_creation_completed','booking',$1,$2::jsonb)",
        [f.bookingId, JSON.stringify({
          creationId: f.input.creationId, customerId: f.customerId,
          setupIntentId: f.setupId,
        })]
      );
    } else if (change === "cancelled") {
      await db.query("UPDATE bookings SET status = 'cancelled' WHERE id = $1",
        [f.bookingId]);
    } else if (change === "archived") {
      await db.query("UPDATE bookings SET archived_at = NOW() WHERE id = $1",
        [f.bookingId]);
    } else if (change === "saved_method") {
      await db.query("UPDATE bookings SET stripe_payment_method_id = 'pm_existing' WHERE id = $1",
        [f.bookingId]);
    } else if (change === "payment_attempt") {
      await db.query(
        "INSERT INTO payment_attempts (booking_id,attempt_number,status,amount_minor,currency,idempotency_key) VALUES ($1,1,'pending',20000,'GBP',$2)",
        [f.bookingId, "setup-recovery-" + crypto.randomUUID()]
      );
    } else {
      await db.query("UPDATE bookings SET stripe_setup_intent_id = $2 WHERE id = $1",
        [f.bookingId, f.setupId]);
    }

    const before = await f.booking();
    const history = await f.history();
    const attempts = (await db.query(
      "SELECT * FROM payment_attempts WHERE booking_id = $1", [f.bookingId]
    )).rows;
    let retrieves = 0;
    mockSetupIntentRetrieve = async () => {
      retrieves++;
      return f.evidence();
    };
    await assert.rejects(recoverSetupIntentReference(f.input, () => true),
      /reservation requires review/);
    assert.equal(retrieves, 0, "Ineligible recovery must not access the provider");
    assert.deepEqual(await f.booking(), before);
    assert.deepEqual(await f.history(), history);
    assert.deepEqual((await db.query(
      "SELECT * FROM payment_attempts WHERE booking_id = $1", [f.bookingId]
    )).rows, attempts);
  });
}
