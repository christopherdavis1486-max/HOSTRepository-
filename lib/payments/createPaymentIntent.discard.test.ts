import { test, mock, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { db } from "../db";
import { BookingError } from "../booking/types";

let create: (params: any, options: any) => Promise<any>;
let retrieve: (...args: any[]) => Promise<any>;
let recoveredHotelRefundCreate: (...args: any[]) => Promise<any> = async () => {
  throw new Error("Unexpected mocked refund creation");
};

let initiate: typeof import("./createPaymentIntent").createPaymentIntentForBooking;
before(async () => {
  mock.module("../notifications/sendNotification", { namedExports: {
    notifyUser: async () => {},
  } });
  const { stripe: realStripe } = await import("./stripeClient");
  mock.module("../messaging/systemMessages", { namedExports: {
    sendBookingConfirmedMessage: async () => {},
    sendBookingCancelledMessage: async () => {},
  } });
  mock.module("./stripeClient", { namedExports: { stripe: {
    webhooks: realStripe.webhooks,
    refunds: {
      create: async (...args: any[]) => recoveredHotelRefundCreate(...args),
      list: async () => { throw new Error("Unexpected mocked refund lookup"); },
    },

    paymentIntents: {
      create: async (params: any, options: any) => create(params, options),
      retrieve: async (...args: any[]) => retrieve(...args),
    },
  } } });
  ({ createPaymentIntentForBooking: initiate } = await import("./createPaymentIntent"));
});
after(async () => {
  const { sessionLockPool } = await import("../db/sessionPool");
  const sessionPool = sessionLockPool();
  try {
    if (sessionPool !== db) await sessionPool.end();
  } finally {
    await db.end();
  }
});
async function createTestBooking(guestSuffix: string) {
  const guestUser = await db.query(`INSERT INTO users (email, password_hash, status) VALUES ($1, 'x', 'active') RETURNING id`, [`access-test-guest-${guestSuffix}@test.host`]);
  const hostUser = await db.query(`INSERT INTO users (email, password_hash, status) VALUES ($1, 'x', 'active') RETURNING id`, [`access-test-host-${guestSuffix}@test.host`]);
  const hostProfile = await db.query(`INSERT INTO host_profiles (user_id, payout_account_status) VALUES ($1, 'active') RETURNING id`, [hostUser.rows[0].id]);
  const property = await db.query(
    `INSERT INTO properties (host_id, name, city, currency, nightly_price, max_guests, status) VALUES ($1, 'Access Test Property', 'Berlin', 'GBP', 150, 2, 'published') RETURNING id`,
    [hostProfile.rows[0].id]
  );
  const booking = await db.query(
    `INSERT INTO bookings (property_id, guest_id, host_id, check_in, check_out, guests, status, guest_name, guest_email, cancellation_policy_snapshot)
     VALUES ($1, $2, $3, '2026-12-01', '2026-12-03', 2, 'confirmed', 'Test Guest', 'test@test.host', $4) RETURNING id`,
    [property.rows[0].id, guestUser.rows[0].id, hostProfile.rows[0].id, JSON.stringify([{ cutoffHours: 120, refundPercent: 100 }, { cutoffHours: 0, refundPercent: 0 }])]
  );
  return { bookingId: booking.rows[0].id, guestId: guestUser.rows[0].id, hostProfileId: hostProfile.rows[0].id };
}


test("legacy payment creation prevents concurrent unpaid discard", async () => {
  const suffix = crypto.randomBytes(8).toString("hex");
  const f = await createTestBooking(suffix);
  await db.query("UPDATE bookings SET status = 'pending_payment' WHERE id = $1", [f.bookingId]);
  await db.query(
    "UPDATE host_profiles SET stripe_connect_account_id = 'acct_discard_fixture' WHERE id = $1",
    [f.hostProfileId]
  );
  await db.query(
    "INSERT INTO booking_price_components (booking_id, currency, accommodation_minor, cleaning_minor, guest_service_fee_minor, taxes_minor, guest_total_minor, host_commission_minor, host_payout_minor, host_revenue_minor, fee_config_version) VALUES ($1, 'GBP', 30000, 0, 0, 0, 30000, 4500, 25500, 4500, 'test')",
    [f.bookingId]
  );

  let entered!: () => void;
  let release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const paused = new Promise<void>(resolve => { release = resolve; });
  let creates = 0;
  create = async params => {
    creates++;
    assert.equal(params.metadata.booking_id, f.bookingId);
    entered();
    await paused;
    return { id: "pi_discard_race_" + suffix, client_secret: "fixture_secret" };
  };

  const payment = initiate(f.bookingId).then(
    value => ({ value, error: undefined }),
    error => ({ value: undefined, error })
  );
  const { discardUnpaidBooking } = await import("../booking/discardUnpaidBooking");
  let settled = false;
  let discard: Promise<any> | undefined;
  let settledDuringCreation = false;
  try {
    await started;
    discard = discardUnpaidBooking(f.bookingId, f.guestId).then(
      value => ({ value, error: undefined }),
      error => ({ value: undefined, error })
    ).finally(() => { settled = true; });
    await new Promise(resolve => setTimeout(resolve, 100));
    settledDuringCreation = settled;
  } finally {
    release();
  }

  const paymentResult = await payment;
  const discardResult = await discard;
  assert.ifError(paymentResult.error);
  assert.equal(settledDuringCreation, false,
    "Discard must wait while payment creation holds booking ownership");
  assert.ok(discardResult.error instanceof BookingError);
  assert.equal(discardResult.error.code, "PAYMENT_EXISTS");
  assert.equal(creates, 1);
  const booking = (await db.query(
    "SELECT status, archived_at FROM bookings WHERE id = $1", [f.bookingId]
  )).rows[0];
  assert.equal(booking.status, "pending_payment");
  assert.equal(booking.archived_at, null);
  const payments = (await db.query(
    "SELECT status, provider_payment_intent_id FROM payments WHERE booking_id = $1",
    [f.bookingId]
  )).rows;
  assert.equal(payments.length, 1);
  assert.equal(payments[0].status, "pending");
  assert.equal(payments[0].provider_payment_intent_id, "pi_discard_race_" + suffix);
});


test("legacy checkout reuses an existing intent with bounded retrieval", async () => {
  const suffix = crypto.randomBytes(8).toString("hex");
  const f = await createTestBooking(suffix);
  await db.query(
    "UPDATE bookings SET status = 'pending_payment' WHERE id = $1", [f.bookingId]
  );
  await db.query(
    "UPDATE host_profiles SET stripe_connect_account_id = 'acct_discard_fixture' WHERE id = $1",
    [f.hostProfileId]
  );
  await db.query(
    "INSERT INTO booking_price_components (booking_id, currency, accommodation_minor, cleaning_minor, guest_service_fee_minor, taxes_minor, guest_total_minor, host_commission_minor, host_payout_minor, host_revenue_minor, fee_config_version) VALUES ($1, 'GBP', 30000, 0, 0, 0, 30000, 4500, 25500, 4500, 'test')",
    [f.bookingId]
  );
  const intentId = "pi_existing_checkout_" + suffix;
  await db.query(
    "INSERT INTO payments (booking_id, provider, provider_payment_intent_id, status, amount_minor, currency) VALUES ($1, 'stripe', $2, 'pending', 30000, 'GBP')",
    [f.bookingId, intentId]
  );
  const before = (await db.query(
    "SELECT * FROM payments WHERE booking_id = $1", [f.bookingId]
  )).rows;
  let retrieves = 0;
  let creates = 0;
  retrieve = async (id, params, options) => {
    retrieves++;
    assert.equal(id, intentId);
    assert.deepEqual(params, {});
    assert.equal(options.timeout, 20000);
    assert.equal(options.maxNetworkRetries, 0);
    return {
      id, status: "requires_confirmation", client_secret: "fixture_reused_secret",
    };
  };
  create = async () => {
    creates++;
    throw new Error("Existing intent must be reused");
  };

  assert.deepEqual(await initiate(f.bookingId), {
    clientSecret: "fixture_reused_secret",
  });
  assert.equal(retrieves, 1);
  assert.equal(creates, 0);
  assert.deepEqual((await db.query(
    "SELECT * FROM payments WHERE booking_id = $1", [f.bookingId]
  )).rows, before);
});


for (const status of ["processing", "succeeded", "requires_capture", "unknown_fixture_status"]) {
  test("legacy checkout refuses replacement for existing provider status: " + status, async () => {
    const suffix = crypto.randomBytes(8).toString("hex");
    const f = await createTestBooking(suffix);
    await db.query(
      "UPDATE bookings SET status = 'pending_payment' WHERE id = $1", [f.bookingId]
    );
    await db.query(
      "UPDATE host_profiles SET stripe_connect_account_id = 'acct_discard_fixture' WHERE id = $1",
      [f.hostProfileId]
    );
    await db.query(
      "INSERT INTO booking_price_components (booking_id, currency, accommodation_minor, cleaning_minor, guest_service_fee_minor, taxes_minor, guest_total_minor, host_commission_minor, host_payout_minor, host_revenue_minor, fee_config_version) VALUES ($1, 'GBP', 30000, 0, 0, 0, 30000, 4500, 25500, 4500, 'test')",
      [f.bookingId]
    );
    const intentId = "pi_existing_status_" + suffix;
    await db.query(
      "INSERT INTO payments (booking_id, provider, provider_payment_intent_id, status, amount_minor, currency) VALUES ($1, 'stripe', $2, 'pending', 30000, 'GBP')",
      [f.bookingId, intentId]
    );
    const before = (await db.query(
      "SELECT * FROM payments WHERE booking_id = $1", [f.bookingId]
    )).rows;
    let retrieves = 0;
    let creates = 0;
    retrieve = async id => {
      retrieves++;
      assert.equal(id, intentId);
      return { id, status, client_secret: "fixture_existing_secret" };
    };
    create = async () => {
      creates++;
      return {
        id: "pi_unsafe_replacement_" + suffix,
        client_secret: "fixture_replacement_secret",
      };
    };

    let error: unknown;
    try { await initiate(f.bookingId); }
    catch (caught) { error = caught; }

    assert.equal(retrieves, 1);
    assert.equal(creates, 0,
      "Existing unresolved or successful intent must never trigger replacement");
    assert.ok(error instanceof Error, "Checkout must refuse this provider status");
    assert.deepEqual((await db.query(
      "SELECT * FROM payments WHERE booking_id = $1", [f.bookingId]
    )).rows, before, "Existing payment reference must remain unchanged");
  });
}


async function checkoutFixture() {
  const suffix = crypto.randomBytes(8).toString("hex");
  const f = await createTestBooking(suffix);
  await db.query(
    "UPDATE bookings SET status = 'pending_payment' WHERE id = $1", [f.bookingId]
  );
  await db.query(
    "UPDATE host_profiles SET stripe_connect_account_id = 'acct_discard_fixture' WHERE id = $1",
    [f.hostProfileId]
  );
  await db.query(
    "INSERT INTO booking_price_components (booking_id, currency, accommodation_minor, cleaning_minor, guest_service_fee_minor, taxes_minor, guest_total_minor, host_commission_minor, host_payout_minor, host_revenue_minor, fee_config_version) VALUES ($1, 'GBP', 30000, 0, 0, 0, 30000, 4500, 25500, 4500, 'test')",
    [f.bookingId]
  );
  return { ...f, suffix };
}

test("legacy checkout replaces an explicitly canceled intent once", async () => {
  const f = await checkoutFixture();
  const oldId = "pi_canceled_" + f.suffix;
  const newId = "pi_replacement_" + f.suffix;
  await db.query(
    "INSERT INTO payments (booking_id, provider, provider_payment_intent_id, status, amount_minor, currency) VALUES ($1, 'stripe', $2, 'pending', 30000, 'GBP')",
    [f.bookingId, oldId]
  );
  let retrieves = 0;
  let creates = 0;
  retrieve = async id => {
    retrieves++;
    assert.equal(id, oldId);
    return { id, status: "canceled" };
  };
  create = async params => {
    creates++;
    assert.equal(params.metadata.booking_id, f.bookingId);
    return { id: newId, client_secret: "fixture_replacement_secret" };
  };

  assert.deepEqual(await initiate(f.bookingId), {
    clientSecret: "fixture_replacement_secret",
  });
  assert.equal(retrieves, 1);
  assert.equal(creates, 1);
  const rows = (await db.query(
    "SELECT * FROM payments WHERE booking_id = $1", [f.bookingId]
  )).rows;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].provider_payment_intent_id, newId);
  assert.equal(rows[0].status, "pending");
});

test("concurrent legacy checkout blocks unresolved ownership then reuses the saved intent", async () => {
  const f = await checkoutFixture();
  const id = "pi_concurrent_checkout_" + f.suffix;
  let creates = 0;
  let retrieves = 0;
  let entered!: () => void;
  let release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const paused = new Promise<void>(resolve => { release = resolve; });

  create = async () => {
    creates++;
    entered();
    await paused;
    return { id, client_secret: "fixture_shared_secret" };
  };
  retrieve = async providerId => {
    retrieves++;
    assert.equal(providerId, id);
    return {
      id, status: "requires_confirmation", client_secret: "fixture_shared_secret",
    };
  };

  const first = initiate(f.bookingId).then(
    value => ({ value, error: undefined }),
    error => ({ value: undefined, error })
  );
  let competing: Promise<any> | undefined;
  try {
    await started;
    competing = initiate(f.bookingId).then(
      value => ({ value, error: undefined }),
      error => ({ value: undefined, error })
    );
  } finally {
    release();
  }

  const firstResult = await first;
  const secondResult = await competing;
  assert.ifError(firstResult.error);
  assert.deepEqual(firstResult.value, { clientSecret: "fixture_shared_secret" });
  // Depending on lock ordering, the competing request either observes the
  // unresolved reservation or the completed reference. Neither may create again.
  if (secondResult.error) {
    assert.match(String(secondResult.error), /requires review; creation blocked/);
  } else {
    assert.deepEqual(secondResult.value, { clientSecret: "fixture_shared_secret" });
  }
  assert.equal(creates, 1);
  assert.deepEqual(await initiate(f.bookingId), {
    clientSecret: "fixture_shared_secret",
  });
  assert.ok(retrieves >= 1);
  assert.equal(creates, 1);

  const rows = (await db.query(
    "SELECT * FROM payments WHERE booking_id = $1", [f.bookingId]
  )).rows;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].provider_payment_intent_id, id);
  assert.equal(rows[0].status, "pending");
});

test("legacy checkout after unpaid discard makes no provider calls", async () => {
  const f = await checkoutFixture();
  const { discardUnpaidBooking } = await import("../booking/discardUnpaidBooking");
  await discardUnpaidBooking(f.bookingId, f.guestId);
  let calls = 0;
  create = async () => { calls++; throw new Error("Unexpected creation"); };
  retrieve = async () => { calls++; throw new Error("Unexpected retrieval"); };

  await assert.rejects(initiate(f.bookingId), /not in pending_payment/);
  assert.equal(calls, 0);
  const row = (await db.query(
    "SELECT status, archived_at FROM bookings WHERE id = $1", [f.bookingId]
  )).rows[0];
  assert.equal(row.status, "cancelled");
  assert.ok(row.archived_at);
  assert.equal((await db.query(
    "SELECT id FROM payments WHERE booking_id = $1", [f.bookingId]
  )).rows.length, 0);
});


test("uncertain legacy intent creation blocks a second create request", async () => {
  const f = await checkoutFixture();
  let creates = 0;
  create = async () => {
    creates++;
    // The provider may have accepted the request before this response failed.
    throw new Error("fixture creation response lost");
  };
  retrieve = async () => {
    throw new Error("No provider reference is available for retrieval");
  };

  await assert.rejects(initiate(f.bookingId), /fixture creation response lost/);

  let retryError: unknown;
  try { await initiate(f.bookingId); }
  catch (error) { retryError = error; }

  assert.equal(creates, 1,
    "An uncertain creation outcome must not authorize another create request");
  assert.ok(retryError instanceof Error);
  const rows = (await db.query(
    "SELECT * FROM payments WHERE booking_id = $1", [f.bookingId]
  )).rows;
  assert.equal(rows.length, 1,
    "Unresolved creation must leave a durable local payment reservation");
  assert.equal(rows[0].provider_payment_intent_id, null);
  assert.equal(rows[0].amount_minor, 30000);
  assert.notEqual(rows[0].status, "paid");
  const booking = (await db.query(
    "SELECT status, archived_at FROM bookings WHERE id = $1", [f.bookingId]
  )).rows[0];
  assert.equal(booking.status, "pending_payment");
  assert.equal(booking.archived_at, null);
});


test("legacy provider success followed by save failure preserves creation ownership", async () => {
  const f = await checkoutFixture();
  const providerId = "pi_save_failure_" + f.suffix;
  let creates = 0;
  create = async () => {
    creates++;
    return { id: providerId, client_secret: "fixture_unsaved_secret" };
  };
  retrieve = async () => { throw new Error("Unexpected retrieval"); };

  const connect = db.connect.bind(db);
  const restorers: Array<() => void> = [];
  const intercepted = mock.method(db, "connect", async (...args: any[]) => {
    if (args.length) return (connect as any)(...args);
    const client = await connect();
    const query = client.query.bind(client);
    const patched = mock.method(client, "query", async (...queryArgs: any[]) => {
      const sql = typeof queryArgs[0] === "string"
        ? queryArgs[0] : queryArgs[0]?.text ?? "";
      if (sql.startsWith("UPDATE payments SET provider_payment_intent_id = $2")) {
        throw new Error("fixture provider reference save failed");
      }
      return (query as any)(...queryArgs);
    });
    restorers.push(() => patched.mock.restore());
    return client;
  });

  try {
    await assert.rejects(initiate(f.bookingId),
      /fixture provider reference save failed/);
  } finally {
    intercepted.mock.restore();
    for (const restore of restorers.reverse()) restore();
  }

  assert.equal(creates, 1);
  const reserved = (await db.query(
    "SELECT * FROM payments WHERE booking_id = $1", [f.bookingId]
  )).rows;
  assert.equal(reserved.length, 1);
  assert.equal(reserved[0].provider_payment_intent_id, null);
  assert.equal(reserved[0].status, "processing");
  assert.equal(reserved[0].failure_code, "legacy_intent_creation_reserved");

  const audit = (await db.query(
    "SELECT * FROM audit_log WHERE object_type = 'payment' AND object_id = $1 AND action = 'legacy_intent_creation_reserved'",
    [reserved[0].id]
  )).rows;
  assert.equal(audit.length, 1);
  assert.equal(audit[0].new_state.bookingId, f.bookingId);
  assert.equal(audit[0].new_state.paymentId, reserved[0].id);

  await assert.rejects(initiate(f.bookingId), /requires review; creation blocked/);
  assert.equal(creates, 1, "Save failure must never authorize another provider creation");
  assert.deepEqual((await db.query(
    "SELECT * FROM payments WHERE booking_id = $1", [f.bookingId]
  )).rows, reserved);
});


test("legacy creation sends the committed reservation identity to the provider", async () => {
  const f = await checkoutFixture();
  const observer = await db.connect();
  let creates = 0;
  let paymentId: string | undefined;
  let attemptId: string | undefined;
  try {
    create = async (params, options) => {
      creates++;
      // This connection is separate from the provider execution transaction.
      const payments = (await observer.query(
        "SELECT * FROM payments WHERE booking_id = $1", [f.bookingId]
      )).rows;
      assert.equal(payments.length, 1);
      const payment = payments[0];
      assert.equal(payment.status, "processing");
      assert.equal(payment.provider_payment_intent_id, null);
      assert.equal(payment.failure_code, "legacy_intent_creation_reserved");

      const audits = (await observer.query(
        "SELECT * FROM audit_log WHERE object_id = $1 AND object_type = 'payment' AND action = 'legacy_intent_creation_reserved'",
        [payment.id]
      )).rows;
      assert.equal(audits.length, 1);
      paymentId = payment.id;
      attemptId = audits[0].id;
      assert.equal(params.metadata.booking_id, f.bookingId);
      assert.equal(params.metadata.host_payment_id, paymentId);
      assert.equal(params.metadata.host_payment_creation_id, attemptId);
      assert.equal(options.idempotencyKey, "host-legacy-intent-" + attemptId);
      assert.equal(options.timeout, 20000);
      assert.equal(options.maxNetworkRetries, 0);
      assert.equal(params.amount, 30000);
      assert.equal(params.currency, "gbp");
      assert.equal(params.application_fee_amount, 4500);
      assert.equal(params.transfer_data.destination, "acct_discard_fixture");
      return {
        id: "pi_committed_reservation_" + f.suffix,
        client_secret: "fixture_committed_secret",
      };
    };

    assert.deepEqual(await initiate(f.bookingId), {
      clientSecret: "fixture_committed_secret",
    });
    assert.equal(creates, 1);
    assert.ok(paymentId);
    assert.ok(attemptId);
    const payment = (await observer.query(
      "SELECT * FROM payments WHERE id = $1", [paymentId]
    )).rows[0];
    assert.equal(payment.status, "pending");
    assert.equal(payment.failure_code, null);
    assert.equal(payment.provider_payment_intent_id,
      "pi_committed_reservation_" + f.suffix);
  } finally {
    observer.release();
  }
});

test("legacy hold expiry preserves uncertain intent creation ownership", async () => {
  const f = await checkoutFixture();
  let creates = 0;
  create = async () => {
    creates++;
    throw new Error("fixture uncertain provider response");
  };

  await assert.rejects(
    initiate(f.bookingId),
    /fixture uncertain provider response/
  );
  assert.equal(creates, 1);

  await db.query(
    "UPDATE bookings SET hold_expires_at = NOW() - INTERVAL '1 hour' WHERE id = $1",
    [f.bookingId]
  );

  const beforeBooking = (await db.query(
    "SELECT * FROM bookings WHERE id = $1", [f.bookingId]
  )).rows;
  const beforePayments = (await db.query(
    "SELECT * FROM payments WHERE booking_id = $1 ORDER BY id", [f.bookingId]
  )).rows;

  assert.equal(beforePayments.length, 1);
  assert.equal(
    beforePayments[0].failure_code,
    "legacy_intent_creation_reserved"
  );

  const { releaseExpiredHold } = await import("../booking/createBooking");
  const result = await releaseExpiredHold(f.bookingId);

  assert.equal(result, null,
    "Uncertain payment creation must block hold expiry");
  assert.deepEqual((await db.query(
    "SELECT * FROM bookings WHERE id = $1", [f.bookingId]
  )).rows, beforeBooking);
  assert.deepEqual((await db.query(
    "SELECT * FROM payments WHERE booking_id = $1 ORDER BY id", [f.bookingId]
  )).rows, beforePayments);
  assert.equal((await db.query(
    "SELECT id FROM audit_log WHERE object_id = $1 AND action = 'booking_hold_expired'",
    [f.bookingId]
  )).rows.length, 0);
});

test("legacy success webhook cannot bypass an unsaved creation reference", async () => {
  const f = await checkoutFixture();
  let creates = 0;
  create = async () => {
    creates++;
    throw new Error("fixture lost creation response");
  };
  await assert.rejects(initiate(f.bookingId), /fixture lost creation response/);

  async function snapshot() {
    return {
      bookings: (await db.query(
        "SELECT * FROM bookings WHERE id = $1", [f.bookingId]
      )).rows,
      payments: (await db.query(
        "SELECT * FROM payments WHERE booking_id = $1 ORDER BY id", [f.bookingId]
      )).rows,
      ledger: (await db.query(
        "SELECT * FROM ledger_entries WHERE booking_id = $1 ORDER BY id", [f.bookingId]
      )).rows,
      payouts: (await db.query(
        "SELECT * FROM payouts WHERE booking_id = $1 ORDER BY id", [f.bookingId]
      )).rows,
    };
  }
  const before = await snapshot();
  assert.equal(before.payments[0].provider_payment_intent_id, null);
  assert.equal(before.payments[0].failure_code, "legacy_intent_creation_reserved");

  const previousSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!previousSecret) process.env.STRIPE_WEBHOOK_SECRET = "whsec_local_reservation_fixture";
  try {
    const { handleStripeWebhook } = await import("./webhookHandler");
    const { signEvent } = await import("./webhookHandler.refund.testHelpers");
    const payload = JSON.stringify({
      id: "evt_unsaved_" + f.suffix,
      object: "event",
      type: "payment_intent.succeeded",
      data: { object: {
        id: "pi_unsaved_" + f.suffix,
        object: "payment_intent",
        status: "succeeded",
        amount: 30000,
        amount_received: 30000,
        currency: "gbp",
        metadata: { booking_id: f.bookingId },
      } },
    });
    const outcome = await handleStripeWebhook(payload, signEvent(payload)).then(
      value => ({ value, error: undefined }),
      error => ({ value: undefined, error })
    );

    assert.deepEqual(await snapshot(), before,
      "An unmatched provider reference must not confirm or book financial entries");
    assert.ok(outcome.error instanceof Error,
      "Unresolved matching must surface for follow-up rather than acknowledge success");
    assert.equal(creates, 1, "Webhook handling must not create another intent");
  } finally {
    if (previousSecret === undefined) delete process.env.STRIPE_WEBHOOK_SECRET;
    else process.env.STRIPE_WEBHOOK_SECRET = previousSecret;
  }
});

test("legacy matched success confirms once and rejects another booking", async () => {
  const owner = await checkoutFixture();
  const other = await checkoutFixture();
  const providerId = "pi_matched_" + owner.suffix;
  let creates = 0;
  create = async () => {
    creates++;
    return { id: providerId, client_secret: "fixture_matched_secret" };
  };
  await initiate(owner.bookingId);

  async function snapshot() {
    const ids = [owner.bookingId, other.bookingId];
    return {
      bookings: (await db.query(
        "SELECT * FROM bookings WHERE id = ANY($1::uuid[]) ORDER BY id", [ids]
      )).rows,
      payments: (await db.query(
        "SELECT * FROM payments WHERE booking_id = ANY($1::uuid[]) ORDER BY id", [ids]
      )).rows,
      ledger: (await db.query(
        "SELECT * FROM ledger_entries WHERE booking_id = ANY($1::uuid[]) ORDER BY id", [ids]
      )).rows,
      payouts: (await db.query(
        "SELECT * FROM payouts WHERE booking_id = ANY($1::uuid[]) ORDER BY id", [ids]
      )).rows,
    };
  }

  const previousSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!previousSecret) process.env.STRIPE_WEBHOOK_SECRET = "whsec_local_reservation_fixture";
  try {
    const { handleStripeWebhook } = await import("./webhookHandler");
    const { signEvent } = await import("./webhookHandler.refund.testHelpers");
    function payload(bookingId: string, suffix: string) {
      return JSON.stringify({
        id: "evt_matched_" + owner.suffix + suffix,
        object: "event",
        type: "payment_intent.succeeded",
        data: { object: {
          id: providerId, object: "payment_intent", status: "succeeded",
          amount: 30000, amount_received: 30000, currency: "gbp",
          metadata: { booking_id: bookingId },
        } },
      });
    }

    const before = await snapshot();
    const wrong = payload(other.bookingId, "_wrong");
    await assert.rejects(
      handleStripeWebhook(wrong, signEvent(wrong)),
      /Matching legacy payment reference required/
    );
    assert.deepEqual(await snapshot(), before,
      "Cross-booking metadata must not change either booking or financial records");

    const valid = payload(owner.bookingId, "_valid");
    await handleStripeWebhook(valid, signEvent(valid));
    const confirmed = await snapshot();
    assert.equal(confirmed.bookings.find(b => b.id === owner.bookingId)?.status, "confirmed");
    assert.equal(confirmed.bookings.find(b => b.id === other.bookingId)?.status, "pending_payment");
    assert.equal(confirmed.payments.length, 1);
    assert.equal(confirmed.payments[0].status, "paid");
    assert.equal(confirmed.ledger.length, 8);
    assert.equal(confirmed.payouts.length, 1);
    assert.ok(confirmed.ledger.every(row => row.booking_id === owner.bookingId));
    assert.equal(confirmed.payouts[0].booking_id, owner.bookingId);

    await handleStripeWebhook(valid, signEvent(valid));
    assert.deepEqual(await snapshot(), confirmed,
      "Duplicate success must not add ledger entries or payouts");
    assert.equal(creates, 1);
  } finally {
    if (previousSecret === undefined) delete process.env.STRIPE_WEBHOOK_SECRET;
    else process.env.STRIPE_WEBHOOK_SECRET = previousSecret;
  }
});

async function legacyRecoveryFixture() {
  const f = await checkoutFixture();
  let creates = 0;
  create = async () => {
    creates++;
    throw new Error("fixture uncertain creation");
  };
  await assert.rejects(initiate(f.bookingId), /fixture uncertain creation/);
  const payment = (await db.query(
    "SELECT * FROM payments WHERE booking_id = $1", [f.bookingId]
  )).rows[0];
  const audit = (await db.query(
    "SELECT * FROM audit_log WHERE object_id = $1 AND action = 'legacy_intent_creation_reserved'",
    [payment.id]
  )).rows[0];
  const input = {
    bookingId: f.bookingId,
    paymentId: payment.id,
    creationId: audit.id,
    providerIntentId: "pi_recovery_" + f.suffix,
  };
  function evidence(status = "requires_payment_method"): any {
    return {
      id: input.providerIntentId, object: "payment_intent", livemode: false,
      status, amount: 30000, currency: "gbp",
      amount_received: status === "succeeded" ? 30000 : 0,
      amount_capturable: 0, capture_method: "automatic",
      application_fee_amount: 4500, on_behalf_of: null,
      transfer_data: { destination: "acct_discard_fixture" },
      metadata: {
        booking_id: f.bookingId,
        host_payment_id: payment.id,
        host_payment_creation_id: audit.id,
      },
    };
  }
  async function snapshot() {
    return {
      booking: (await db.query(
        "SELECT * FROM bookings WHERE id = $1", [f.bookingId]
      )).rows,
      payment: (await db.query(
        "SELECT * FROM payments WHERE id = $1", [payment.id]
      )).rows,
      audits: (await db.query(
        "SELECT * FROM audit_log WHERE object_id = $1 ORDER BY id", [payment.id]
      )).rows,
      ledger: (await db.query(
        "SELECT * FROM ledger_entries WHERE booking_id = $1 ORDER BY id", [f.bookingId]
      )).rows,
      payouts: (await db.query(
        "SELECT * FROM payouts WHERE booking_id = $1 ORDER BY id", [f.bookingId]
      )).rows,
    };
  }
  const { recoverLegacyIntentReference: recover } = await import("./recoverLegacyIntentReference");
  return { ...f, input, evidence, snapshot, recover, creates: () => creates };
}

for (const status of [
  "requires_payment_method", "requires_confirmation", "requires_action",
  "processing", "succeeded", "canceled",
]) {
  test("legacy reference recovery retains reservation: " + status, async () => {
    const f = await legacyRecoveryFixture();
    const before = await f.snapshot();
    let reads = 0;
    retrieve = async (id, params, options) => {
      reads++;
      assert.equal(id, f.input.providerIntentId);
      assert.deepEqual(params, {});
      assert.deepEqual(options, { timeout: 20000, maxNetworkRetries: 0 });
      return f.evidence(status);
    };
    assert.deepEqual(await f.recover(f.input, () => true), { recorded: true });
    const after = await f.snapshot();
    assert.deepEqual(after.booking, before.booking);
    assert.deepEqual(after.ledger, before.ledger);
    assert.deepEqual(after.payouts, before.payouts);
    assert.equal(after.payment[0].provider_payment_intent_id, f.input.providerIntentId);
    assert.equal(after.payment[0].status, "processing");
    assert.equal(after.payment[0].failure_code, "legacy_intent_creation_reserved");
    const recovered = after.audits.filter(a => a.action === "legacy_intent_reference_recovered");
    assert.equal(recovered.length, 1);
    assert.equal(recovered[0].new_state.creationId, f.input.creationId);
    assert.equal(recovered[0].new_state.reservationRetained, true);

    assert.deepEqual(await f.recover(f.input, () => true), { recorded: false });
    assert.deepEqual(await f.snapshot(), after);
    await assert.rejects(initiate(f.bookingId), /requires review/);
    assert.equal(f.creates(), 1);
    assert.equal(reads, 2);
  });
}

for (const mismatch of ["amount", "creation", "destination", "live"]) {
  test("legacy reference recovery rejects mismatched " + mismatch, async () => {
    const f = await legacyRecoveryFixture();
    const before = await f.snapshot();
    retrieve = async () => {
      const value = f.evidence();
      if (mismatch === "amount") value.amount++;
      if (mismatch === "creation") value.metadata.host_payment_creation_id = f.bookingId;
      if (mismatch === "destination") value.transfer_data.destination = "acct_other";
      if (mismatch === "live") value.livemode = true;
      return value;
    };
    await assert.rejects(f.recover(f.input, () => true), /evidence mismatch/);
    assert.deepEqual(await f.snapshot(), before);
    assert.equal(f.creates(), 1);
  });
}

test("legacy reference recovery disabled gate prevents provider access", async () => {
  const f = await legacyRecoveryFixture();
  const before = await f.snapshot();
  let reads = 0;
  retrieve = async () => { reads++; return f.evidence(); };
  assert.deepEqual(await f.recover(f.input), { recorded: false });
  assert.equal(reads, 0);
  assert.deepEqual(await f.snapshot(), before);
});

test("legacy reference recovery gate shutdown during retrieval blocks recording", async () => {
  const f = await legacyRecoveryFixture();
  const before = await f.snapshot();
  let enabled = true;
  let reads = 0;
  retrieve = async () => {
    reads++;
    enabled = false;
    return f.evidence();
  };
  assert.deepEqual(await f.recover(f.input, () => enabled), { recorded: false });
  assert.equal(reads, 1);
  assert.deepEqual(await f.snapshot(), before);
});

test("legacy reference recovery retrieval failure preserves reservation", async () => {
  const f = await legacyRecoveryFixture();
  const before = await f.snapshot();
  retrieve = async () => { throw new Error("fixture retrieval unavailable"); };
  await assert.rejects(f.recover(f.input, () => true), /fixture retrieval unavailable/);
  assert.deepEqual(await f.snapshot(), before);
  assert.equal(f.creates(), 1);
});

test("legacy reference recovery audit failure rolls back reference", async () => {
  const f = await legacyRecoveryFixture();
  const before = await f.snapshot();
  retrieve = async () => f.evidence();

  const originalConnect = db.connect;
  const restorers: (() => void)[] = [];
  let injected = 0;
  (db as any).connect = async function (...args: any[]) {
    if (args.length) return (originalConnect as any).apply(db, args);
    const client = await (originalConnect as any).call(db);
    const originalQuery = client.query;
    client.query = function (...queryArgs: any[]) {
      const sql = queryArgs[0];
      if (typeof sql === "string" &&
          sql.includes("INSERT INTO audit_log") &&
          sql.includes("'legacy_intent_reference_recovered'")) {
        injected++;
        throw new Error("fixture recovery audit failure");
      }
      return originalQuery.apply(client, queryArgs);
    };
    restorers.push(() => { client.query = originalQuery; });
    return client;
  };

  try {
    await assert.rejects(
      f.recover(f.input, () => true),
      /fixture recovery audit failure/
    );
  } finally {
    db.connect = originalConnect;
    for (const restore of restorers.reverse()) restore();
  }

  assert.equal(injected, 1, "Must fail at the recovery audit insertion");
  assert.deepEqual(await f.snapshot(), before,
    "Reference and audit must roll back together");
  assert.equal(f.creates(), 1);

  assert.deepEqual(await f.recover(f.input, () => true), { recorded: true });
  const after = await f.snapshot();
  assert.equal(after.payment[0].provider_payment_intent_id, f.input.providerIntentId);
  assert.equal(after.audits.filter(
    a => a.action === "legacy_intent_reference_recovered"
  ).length, 1);
});

test("concurrent legacy reference recovery records one reference and audit", async () => {
  const f = await legacyRecoveryFixture();
  const before = await f.snapshot();
  let reads = 0;
  retrieve = async () => {
    reads++;
    return f.evidence();
  };

  const results = await Promise.all([
    f.recover(f.input, () => true),
    f.recover(f.input, () => true),
  ]);

  assert.equal(results.filter(r => r.recorded).length, 1);
  assert.equal(results.filter(r => !r.recorded).length, 1);
  const after = await f.snapshot();
  assert.deepEqual(after.booking, before.booking);
  assert.deepEqual(after.ledger, before.ledger);
  assert.deepEqual(after.payouts, before.payouts);
  assert.equal(after.payment[0].provider_payment_intent_id, f.input.providerIntentId);
  assert.equal(after.payment[0].status, "processing");
  assert.equal(after.payment[0].failure_code, "legacy_intent_creation_reserved");
  assert.equal(after.audits.filter(
    a => a.action === "legacy_intent_reference_recovered"
  ).length, 1);
  assert.equal(reads, 2);
  assert.equal(f.creates(), 1);
});


async function deliverRecoveredLifecycleEvent(
  f: { evidence: (status: string) => any },
  type: "payment_intent.succeeded" | "payment_intent.payment_failed",
) {
  const previousSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!previousSecret) process.env.STRIPE_WEBHOOK_SECRET = "whsec_local_recovered_lifecycle";
  try {
    const { handleStripeWebhook } = await import("./webhookHandler");
    const { signEvent } = await import("./webhookHandler.refund.testHelpers");
    const intent = f.evidence(
      type === "payment_intent.succeeded" ? "succeeded" : "requires_payment_method"
    );
    if (type === "payment_intent.payment_failed") {
      intent.last_payment_error = {
        code: "card_declined", message: "Local fixture decline",
      };
    }
    const payload = JSON.stringify({
      id: "evt_recovered_" + crypto.randomBytes(8).toString("hex"),
      object: "event",
      type,
      data: { object: intent },
    });
    await handleStripeWebhook(payload, signEvent(payload));
  } finally {
    if (previousSecret === undefined) delete process.env.STRIPE_WEBHOOK_SECRET;
    else process.env.STRIPE_WEBHOOK_SECRET = previousSecret;
  }
}

test("recovered legacy lifecycle: success confirms once through duplicate delivery", async () => {
  const f = await legacyRecoveryFixture();
  retrieve = async () => f.evidence("processing");
  await f.recover(f.input, () => true);
  await deliverRecoveredLifecycleEvent(f, "payment_intent.succeeded");

  const paid = await f.snapshot();
  assert.equal(paid.booking[0].status, "confirmed");
  assert.equal(paid.payment[0].status, "paid");
  assert.equal(paid.payment[0].provider_payment_intent_id, f.input.providerIntentId);
  assert.equal(paid.ledger.length, 8);
  assert.equal(paid.payouts.length, 1);

  await deliverRecoveredLifecycleEvent(f, "payment_intent.succeeded");
  assert.deepEqual(await f.snapshot(), paid);
  assert.equal(f.creates(), 1);
});

test("recovered legacy lifecycle: failure retains ownership and blocks expiry and creation", async () => {
  const f = await legacyRecoveryFixture();
  retrieve = async () => f.evidence("processing");
  await f.recover(f.input, () => true);
  await db.query(
    "UPDATE bookings SET hold_expires_at = NOW() - INTERVAL '1 hour' WHERE id = $1",
    [f.bookingId]
  );
  const before = await f.snapshot();

  await deliverRecoveredLifecycleEvent(f, "payment_intent.payment_failed");
  const failed = await f.snapshot();
  assert.equal(failed.payment[0].failure_code, "legacy_intent_creation_reserved",
    "A failed attempt does not prove the intent is canceled or release unresolved ownership");
  assert.equal(failed.payment[0].provider_payment_intent_id, f.input.providerIntentId);
  assert.deepEqual(failed.booking, before.booking);
  assert.deepEqual(failed.ledger, before.ledger);
  assert.deepEqual(failed.payouts, before.payouts);

  const { releaseExpiredHold } = await import("../booking/createBooking");
  assert.equal(await releaseExpiredHold(f.bookingId), null);
  assert.deepEqual(await f.snapshot(), failed);
  await assert.rejects(initiate(f.bookingId));
  assert.equal(f.creates(), 1);
});


test("recovered legacy lifecycle: stale failure cannot undo success", async () => {
  const f = await legacyRecoveryFixture();
  retrieve = async () => f.evidence("processing");
  await f.recover(f.input, () => true);
  await deliverRecoveredLifecycleEvent(f, "payment_intent.succeeded");
  const paid = await f.snapshot();
  assert.equal(paid.payment[0].status, "paid");

  await deliverRecoveredLifecycleEvent(f, "payment_intent.payment_failed");
  assert.deepEqual(await f.snapshot(), paid,
    "An older failed attempt must not downgrade a completed payment");

  await deliverRecoveredLifecycleEvent(f, "payment_intent.succeeded");
  assert.deepEqual(await f.snapshot(), paid,
    "Success redelivery after stale failure must not duplicate financial entries");
  assert.equal(f.creates(), 1);
});


test("recovered legacy lifecycle: failure then success after hold deadline", async () => {
  const f = await legacyRecoveryFixture();
  retrieve = async () => f.evidence("processing");
  await f.recover(f.input, () => true);
  await db.query(
    "UPDATE bookings SET hold_expires_at = NOW() - INTERVAL '1 hour' WHERE id = $1",
    [f.bookingId]
  );

  await deliverRecoveredLifecycleEvent(f, "payment_intent.payment_failed");
  const unresolved = await f.snapshot();
  assert.equal(unresolved.payment[0].status, "processing");
  assert.equal(unresolved.payment[0].failure_code, "legacy_intent_creation_reserved");

  const { releaseExpiredHold } = await import("../booking/createBooking");
  assert.equal(await releaseExpiredHold(f.bookingId), null);
  assert.deepEqual(await f.snapshot(), unresolved);
  await assert.rejects(initiate(f.bookingId));

  await deliverRecoveredLifecycleEvent(f, "payment_intent.succeeded");
  const paid = await f.snapshot();
  assert.equal(paid.booking[0].status, "confirmed");
  assert.equal(paid.payment[0].status, "paid");
  assert.equal(paid.ledger.length, 8);
  assert.equal(paid.payouts.length, 1);

  assert.equal(await releaseExpiredHold(f.bookingId), null);
  await deliverRecoveredLifecycleEvent(f, "payment_intent.payment_failed");
  await deliverRecoveredLifecycleEvent(f, "payment_intent.succeeded");
  assert.deepEqual(await f.snapshot(), paid);
  assert.equal(f.creates(), 1);
});




test("recovered hotel lifecycle: late success preserves replacement and submits one refund", async () => {
  const suffix = crypto.randomBytes(8).toString("hex");
  const owner = await createTestBooking(suffix);
  await db.query(
    "UPDATE host_profiles SET stripe_connect_account_id = 'acct_recovered_hotel' WHERE id = $1",
    [owner.hostProfileId]
  );
  const property = (await db.query(
    `INSERT INTO properties
      (host_id,name,city,property_type,status,currency,nightly_price,max_guests,
       compliance_status,accommodation_vat_rate,cleaning_vat_rate)
     VALUES ($1,'Recovered hotel fixture','Liverpool','Hotel','draft','GBP',100,2,'approved',0,0)
     RETURNING id`, [owner.hostProfileId]
  )).rows[0];
  const image = (await db.query(
    `INSERT INTO property_images
      (property_id,blob_url,blob_pathname,content_type,size_bytes)
     VALUES ($1,$2,$3,'image/jpeg',100) RETURNING id`,
    [property.id, "https://example.invalid/" + suffix + ".jpg", suffix + ".jpg"]
  )).rows[0];
  const { saveRoomType, roomNights } = await import("../hotels/rooms");
  const room = await saveRoomType(property.id, null, {
    name: "Double", description: "Recovered hotel test room",
    maxGuests: 2, totalRooms: 1, nightlyPrice: 100, cleaningFee: 0,
    active: true, imageIds: [image.id],
  });
  await db.query("UPDATE properties SET status = 'published' WHERE id = $1", [property.id]);
  const date = (days: number) => new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);
  const input = {
    propertyId: property.id, guestId: owner.guestId,
    roomTypeId: room.id, roomQuantity: 1, guests: 2,
    checkIn: date(30), checkOut: date(32),
    guestName: "Local fixture", guestEmail: "fixture@test.host",
    idempotencyKey: crypto.randomUUID(),
  };
  const { createBooking, releaseExpiredHold } = await import("../booking/createBooking");
  const booking = await createBooking(input);
  let creates = 0;
  create = async () => { creates++; throw new Error("fixture lost hotel response"); };
  await assert.rejects(initiate(booking.id), /fixture lost hotel response/);
  const payment = (await db.query(
    "SELECT * FROM payments WHERE booking_id = $1", [booking.id]
  )).rows[0];
  const audit = (await db.query(
    "SELECT * FROM audit_log WHERE object_id = $1 AND action = 'legacy_intent_creation_reserved'",
    [payment.id]
  )).rows[0];
  const pc = (await db.query(
    "SELECT * FROM booking_price_components WHERE booking_id = $1", [booking.id]
  )).rows[0];
  const providerId = "pi_recovered_hotel_" + suffix;
  const evidence = (status: string): any => ({
    id: providerId, object: "payment_intent", livemode: false, status,
    amount: pc.guest_total_minor, currency: String(pc.currency).trim().toLowerCase(),
    amount_received: status === "succeeded" ? pc.guest_total_minor : 0,
    amount_capturable: 0, capture_method: "automatic",
    application_fee_amount: pc.host_revenue_minor, on_behalf_of: null,
    transfer_data: { destination: "acct_recovered_hotel" },
    metadata: {
      booking_id: booking.id, host_payment_id: payment.id,
      host_payment_creation_id: audit.id,
    },
  });
  retrieve = async () => evidence("processing");
  const { recoverLegacyIntentReference } = await import("./recoverLegacyIntentReference");
  assert.deepEqual(await recoverLegacyIntentReference({
    bookingId: booking.id, paymentId: payment.id,
    creationId: audit.id, providerIntentId: providerId,
  }, () => true), { recorded: true });

  await db.query(
    "UPDATE bookings SET hold_expires_at = NOW() - INTERVAL '1 hour' WHERE id = $1",
    [booking.id]
  );
  assert.equal(await releaseExpiredHold(booking.id), null);
  const released = await roomNights(db, room.id, input.checkIn, input.checkOut);
  assert.ok(released.length === 2 && released.every(n => n.reserved === 0));
  const replacement = await createBooking({ ...input, idempotencyKey: crypto.randomUUID() });
  const replacementBefore = (await db.query(
    "SELECT * FROM bookings WHERE id = $1", [replacement.id]
  )).rows;

  let refunds = 0;
  recoveredHotelRefundCreate = async (params, options) => {
    refunds++;
    assert.equal(params.payment_intent, providerId);
    assert.equal(params.amount, pc.guest_total_minor);
    assert.equal(params.reverse_transfer, true);
    assert.equal(params.refund_application_fee, true);
    assert.equal(options.idempotencyKey, "host-refund-" + params.metadata.host_refund_id);
    return { id: "re_recovered_hotel_" + suffix, status: "pending", amount: params.amount };
  };

  const previousSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!previousSecret) process.env.STRIPE_WEBHOOK_SECRET = "whsec_local_recovered_hotel";
  try {
    const { handleStripeWebhook } = await import("./webhookHandler");
    const { signEvent } = await import("./webhookHandler.refund.testHelpers");
    async function deliver(type: string) {
      const intent = evidence(type === "payment_intent.succeeded" ? "succeeded" : "requires_payment_method");
      const payload = JSON.stringify({
        id: "evt_recovered_hotel_" + crypto.randomBytes(8).toString("hex"),
        object: "event", type, data: { object: intent },
      });
      await handleStripeWebhook(payload, signEvent(payload));
    }
    await deliver("payment_intent.payment_failed");
    assert.equal(await releaseExpiredHold(booking.id), null);
    await deliver("payment_intent.succeeded");
    const late = (await db.query(
      "SELECT status,hotel_late_payment FROM bookings WHERE id = $1", [booking.id]
    )).rows[0];
    assert.equal(late.status, "cancelled");
    assert.equal(late.hotel_late_payment, true);
    assert.equal(Number((await db.query(
      "SELECT COUNT(*) FROM payouts WHERE booking_id = $1", [booking.id]
    )).rows[0].count), 0);
    const ledgerBefore = (await db.query(
      "SELECT * FROM ledger_entries WHERE booking_id = $1 ORDER BY id", [booking.id]
    )).rows;
    assert.equal(ledgerBefore.length, 8);

    await deliver("payment_intent.payment_failed");
    await deliver("payment_intent.succeeded");
    assert.equal(refunds, 1);
    assert.equal(creates, 1);
    const refundRows = (await db.query(
      "SELECT * FROM refunds WHERE payment_id = $1", [payment.id]
    )).rows;
    assert.equal(refundRows.length, 1);
    assert.equal(refundRows[0].status, "pending");
    assert.equal(refundRows[0].provider_refund_id, "re_recovered_hotel_" + suffix);
    assert.deepEqual((await db.query(
      "SELECT * FROM ledger_entries WHERE booking_id = $1 ORDER BY id", [booking.id]
    )).rows, ledgerBefore);
    assert.deepEqual((await db.query(
      "SELECT * FROM bookings WHERE id = $1", [replacement.id]
    )).rows, replacementBefore);
    const nights = await roomNights(db, room.id, input.checkIn, input.checkOut);
    assert.ok(nights.length === 2 && nights.every(n => n.reserved === 1));
  } finally {
    if (previousSecret === undefined) delete process.env.STRIPE_WEBHOOK_SECRET;
    else process.env.STRIPE_WEBHOOK_SECRET = previousSecret;
    recoveredHotelRefundCreate = async () => { throw new Error("Unexpected mocked refund creation"); };
  }
});


async function ordinaryFailureFixture() {
  const f = await checkoutFixture();
  const providerId = "pi_ordinary_failure_" + f.suffix;
  let creates = 0;
  create = async () => {
    creates++;
    return { id: providerId, client_secret: "fixture_ordinary_secret" };
  };
  await initiate(f.bookingId);
  const evidence = (status: string) => ({
    id: providerId, object: "payment_intent", status,
    amount: 30000, amount_received: status === "succeeded" ? 30000 : 0,
    currency: "gbp", metadata: { booking_id: f.bookingId },
  });
  async function snapshot() {
    return {
      booking: (await db.query("SELECT * FROM bookings WHERE id = $1", [f.bookingId])).rows,
      payments: (await db.query("SELECT * FROM payments WHERE booking_id = $1 ORDER BY id", [f.bookingId])).rows,
      ledger: (await db.query("SELECT * FROM ledger_entries WHERE booking_id = $1 ORDER BY id", [f.bookingId])).rows,
      payouts: (await db.query("SELECT * FROM payouts WHERE booking_id = $1 ORDER BY id", [f.bookingId])).rows,
    };
  }
  return { ...f, evidence, snapshot, creates: () => creates };
}

test("legacy failure compatibility: ordinary unpaid failure remains supported", async () => {
  const f = await ordinaryFailureFixture();
  await deliverRecoveredLifecycleEvent(f, "payment_intent.payment_failed");
  const failed = await f.snapshot();
  assert.equal(failed.booking[0].status, "pending_payment");
  assert.equal(failed.payments[0].status, "failed");
  assert.equal(failed.payments[0].failure_code, "card_declined");
  assert.equal(failed.ledger.length, 0);
  assert.equal(failed.payouts.length, 0);

  await deliverRecoveredLifecycleEvent(f, "payment_intent.succeeded");
  const paid = await f.snapshot();
  assert.equal(paid.booking[0].status, "confirmed");
  assert.equal(paid.payments[0].status, "paid");
  assert.equal(paid.ledger.length, 8);
  assert.equal(paid.payouts.length, 1);
  assert.equal(f.creates(), 1);
});

test("legacy failure compatibility: mismatched booking cannot change payment", async () => {
  const f = await ordinaryFailureFixture();
  const other = await checkoutFixture();
  const before = await f.snapshot();
  const otherBefore = (await db.query(
    "SELECT * FROM bookings WHERE id = $1", [other.bookingId]
  )).rows;
  await deliverRecoveredLifecycleEvent({
    evidence: status => ({
      ...f.evidence(status), metadata: { booking_id: other.bookingId },
    }),
  }, "payment_intent.payment_failed");
  assert.deepEqual(await f.snapshot(), before);
  assert.deepEqual((await db.query(
    "SELECT * FROM bookings WHERE id = $1", [other.bookingId]
  )).rows, otherBefore);
});

for (const status of ["partially_refunded", "refunded"]) {
  test("legacy failure compatibility: stale failure preserves " + status, async () => {
    const f = await ordinaryFailureFixture();
    await deliverRecoveredLifecycleEvent(f, "payment_intent.succeeded");
    // Isolate failure-handler monotonicity; this is not refund-completion evidence.
    await db.query(
      "UPDATE payments SET status = $2 WHERE booking_id = $1",
      [f.bookingId, status]
    );
    const before = await f.snapshot();
    await deliverRecoveredLifecycleEvent(f, "payment_intent.payment_failed");
    assert.deepEqual(await f.snapshot(), before);
  });
}
