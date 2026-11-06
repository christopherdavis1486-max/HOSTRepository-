import { test, mock, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "crypto";
import { NextRequest } from "next/server";
import { db } from "../db";

let mockSetupIntentCreate: any;
let mockSetupIntentRetrieve: any;
let mockCustomerCreate: any;
let mockPaymentIntentCreate: any;
let intentPOST: typeof import("../../app/api/payments/intent/route").POST;
let setupIntentPOST: typeof import("../../app/api/payments/setup-intent/route").POST;
let bookingsPOST: typeof import("../../app/api/bookings/route").POST;
let bookingDetailGET: typeof import("../../app/api/bookings/[id]/route").GET;
let mockSession: { user: { id: string; hostProfileId: string | null; roles: string[]; sessionId: string; sessionVersion: number } } | null = null;

before(async () => {
  mock.module("../notifications/emailProvider", {
    namedExports: { sendEmail: async () => {} },
  });
  mock.module("next-auth", { namedExports: { getServerSession: async () => mockSession } });
  mock.module("./stripeClient", {
    namedExports: {
      stripe: {
        setupIntents: { create: async (...args: any[]) => mockSetupIntentCreate(...args), retrieve: async (...args: any[]) => mockSetupIntentRetrieve(...args) },
        customers: { create: async (...args: any[]) => mockCustomerCreate(...args) },
        paymentIntents: { create: async (...args: any[]) => mockPaymentIntentCreate(...args), retrieve: async () => { throw new Error("not used in these tests"); } },
      },
    },
  });
  ({ POST: intentPOST } = await import("../../app/api/payments/intent/route"));
  ({ POST: setupIntentPOST } = await import("../../app/api/payments/setup-intent/route"));
  ({ POST: bookingsPOST } = await import("../../app/api/bookings/route"));
  ({ GET: bookingDetailGET } = await import("../../app/api/bookings/[id]/route"));

  const check = await db.query(`SELECT COUNT(*) FROM fee_configs WHERE active = TRUE`);
  if (Number(check.rows[0].count) === 0) throw new Error("No active fee_configs row — run scripts/seedFeeConfig.ts first");
});
after(async () => { await db.end(); });

function routeSetupEvidence(bookingId: string, customerId: string, setupId: string) {
  return {
    id: setupId, object: "setup_intent", status: "requires_payment_method",
    customer: customerId, usage: "off_session",
    metadata: { booking_id: bookingId },
    client_secret: setupId + "_secret_fixture",
  };
}

async function setupPublishedProperty(suffix: string) {
  const hostUser = await db.query(`INSERT INTO users (email, password_hash, status) VALUES ($1, 'x', 'active') RETURNING id`, [`b10-host-${suffix}@test.host`]);
  const hostProfile = await db.query(`INSERT INTO host_profiles (user_id, stripe_connect_account_id, payout_account_status) VALUES ($1, 'acct_test', 'active') RETURNING id`, [hostUser.rows[0].id]);
  const property = await db.query(`INSERT INTO properties (host_id, name, city, currency, nightly_price, max_guests, status, compliance_status, accommodation_vat_rate, cleaning_vat_rate) VALUES ($1, 'B10 Test Property', 'Liverpool', 'GBP', 100, 2, 'published', 'approved', 0, 0) RETURNING id`, [hostProfile.rows[0].id]);
  const guestUser = await db.query(`INSERT INTO users (email, password_hash, status) VALUES ($1, 'x', 'active') RETURNING id`, [`b10-guest-${suffix}@test.host`]);
  const session = await db.query(
    `INSERT INTO auth_sessions (user_id, expires_at)
     VALUES ($1, NOW() + INTERVAL '1 day')
     RETURNING id`,
    [guestUser.rows[0].id]
  );
  return {
    propertyId: property.rows[0].id as string,
    guestId: guestUser.rows[0].id as string,
    sessionId: session.rows[0].id as string,
  };
}

test("A: with the flag genuinely unset, POST /api/bookings creates destination_charge_legacy and /api/payments/intent works exactly as before", async () => {
  delete process.env.ENABLE_DELAYED_CHARGE_BOOKINGS;
  const suffix = crypto.randomBytes(4).toString("hex");
  const { propertyId, guestId, sessionId } = await setupPublishedProperty(suffix);
  mockSession = {
    user: {
      id: guestId,
      hostProfileId: null,
      roles: ["guest"],
      sessionId,
      sessionVersion: 1,
    },
  };

  const bookingReq = new NextRequest("http://localhost/api/bookings", {
    method: "POST",
    headers: { "Idempotency-Key": crypto.randomUUID() },
    body: JSON.stringify({ propertyId, checkIn: "2026-12-01", checkOut: "2026-12-03", guests: 1, guestName: "A Test", guestEmail: "a@test.host" }),
  });
  const bookingRes = await bookingsPOST(bookingReq);
  const bookingData = await bookingRes.json();
  assert.equal(bookingData.booking.paymentFlowVersion, "destination_charge_legacy");

  let stripeSetupIntentCalled = false;
  mockSetupIntentCreate = async () => { stripeSetupIntentCalled = true; return { id: "should_never_happen" }; };
  mockPaymentIntentCreate = async () => ({ id: `pi_test_${suffix}`, client_secret: "pi_secret_abc" });

  const intentReq = new NextRequest("http://localhost/api/payments/intent", { method: "POST", body: JSON.stringify({ bookingId: bookingData.booking.id }) });
  const intentRes = await intentPOST(intentReq);
  const intentData = await intentRes.json();
  assert.equal(intentRes.status, 200);
  assert.ok(intentData.clientSecret, "the existing legacy PaymentIntent flow must work exactly as before");
  assert.equal(stripeSetupIntentCalled, false, "the SetupIntent flow must never be invoked for a legacy booking");
});

test("A: /api/payments/setup-intent is not invoked and is not usable for a legacy booking", async () => {
  const suffix = crypto.randomBytes(4).toString("hex");
  const { propertyId, guestId, sessionId } = await setupPublishedProperty(suffix);
  mockSession = {
    user: {
      id: guestId,
      hostProfileId: null,
      roles: ["guest"],
      sessionId,
      sessionVersion: 1,
    },
  };

  const bookingReq = new NextRequest("http://localhost/api/bookings", {
    method: "POST",
    headers: { "Idempotency-Key": crypto.randomUUID() },
    body: JSON.stringify({ propertyId, checkIn: "2026-12-05", checkOut: "2026-12-07", guests: 1, guestName: "A2 Test", guestEmail: "a2@test.host" }),
  });
  const bookingRes = await bookingsPOST(bookingReq);
  const bookingData = await bookingRes.json();

  const setupReq = new NextRequest("http://localhost/api/payments/setup-intent", { method: "POST", body: JSON.stringify({ bookingId: bookingData.booking.id }) });
  const setupRes = await setupIntentPOST(setupReq);
  const setupData = await setupRes.json();
  assert.equal(setupData.success, false);
  assert.equal(setupData.error.code, "WRONG_PAYMENT_FLOW");
});

test("B: with the flag ON, POST /api/bookings creates separate_charges_delayed_v1 and /api/payments/setup-intent creates a real SetupIntent, never a PaymentIntent", async () => {
  process.env.ENABLE_DELAYED_CHARGE_BOOKINGS = "true";
  const suffix = crypto.randomBytes(4).toString("hex");
  const { propertyId, guestId, sessionId } = await setupPublishedProperty(suffix);
  mockSession = {
    user: {
      id: guestId,
      hostProfileId: null,
      roles: ["guest"],
      sessionId,
      sessionVersion: 1,
    },
  };

  const bookingReq = new NextRequest("http://localhost/api/bookings", {
    method: "POST",
    headers: { "Idempotency-Key": crypto.randomUUID() },
    body: JSON.stringify({ propertyId, checkIn: "2026-12-10", checkOut: "2026-12-12", guests: 1, guestName: "B Test", guestEmail: "b@test.host" }),
  });
  const bookingRes = await bookingsPOST(bookingReq);
  const bookingData = await bookingRes.json();
  assert.equal(bookingData.booking.paymentFlowVersion, "separate_charges_delayed_v1");

  let paymentIntentCalled = false;
  mockPaymentIntentCreate = async () => { paymentIntentCalled = true; return { id: "should_never_happen" }; };
  mockCustomerCreate = async () => ({ id: `cus_test_${suffix}` });
  mockSetupIntentCreate = async () => routeSetupEvidence(bookingData.booking.id, "cus_test_" + suffix, "seti_test_" + suffix);

  const setupReq = new NextRequest("http://localhost/api/payments/setup-intent", { method: "POST", body: JSON.stringify({ bookingId: bookingData.booking.id }) });
  const setupRes = await setupIntentPOST(setupReq);
  const setupData = await setupRes.json();

  assert.equal(setupRes.status, 200);
  assert.equal(setupData.kind, "setup_intent", "the response must explicitly identify setup-intent semantics, not leave the client to infer it");
  assert.ok(setupData.clientSecret);
  assert.equal(paymentIntentCalled, false, "no PaymentIntent must ever be created for a new-architecture booking at this stage");

  const paymentsRow = await db.query(`SELECT COUNT(*) FROM payments WHERE booking_id = $1`, [bookingData.booking.id]);
  assert.equal(Number(paymentsRow.rows[0].count), 0, "no legacy payments row — and therefore no charge — must exist for this booking");

  delete process.env.ENABLE_DELAYED_CHARGE_BOOKINGS;
});

test("B: /api/payments/intent is refused for a separate_charges_delayed_v1 booking", async () => {
  process.env.ENABLE_DELAYED_CHARGE_BOOKINGS = "true";
  const suffix = crypto.randomBytes(4).toString("hex");
  const { propertyId, guestId, sessionId } = await setupPublishedProperty(suffix);
  mockSession = {
    user: {
      id: guestId,
      hostProfileId: null,
      roles: ["guest"],
      sessionId,
      sessionVersion: 1,
    },
  };

  const bookingReq = new NextRequest("http://localhost/api/bookings", {
    method: "POST",
    headers: { "Idempotency-Key": crypto.randomUUID() },
    body: JSON.stringify({ propertyId, checkIn: "2026-12-15", checkOut: "2026-12-17", guests: 1, guestName: "B2 Test", guestEmail: "b2@test.host" }),
  });
  const bookingRes = await bookingsPOST(bookingReq);
  const bookingData = await bookingRes.json();

  let paymentIntentCalled = false;
  mockPaymentIntentCreate = async () => { paymentIntentCalled = true; return { id: "x" }; };

  const intentReq = new NextRequest("http://localhost/api/payments/intent", { method: "POST", body: JSON.stringify({ bookingId: bookingData.booking.id }) });
  const intentRes = await intentPOST(intentReq);
  const intentData = await intentRes.json();

  assert.equal(intentData.success, false);
  assert.equal(intentData.error.code, "WRONG_PAYMENT_FLOW");
  assert.equal(paymentIntentCalled, false, "Critical Requirement #1 — a delayed-charge booking must never reach createPaymentIntentForBooking");

  delete process.env.ENABLE_DELAYED_CHARGE_BOOKINGS;
});

test("C: the same booking Idempotency-Key submitted twice does not create a second booking", async () => {
  const suffix = crypto.randomBytes(4).toString("hex");
  const { propertyId, guestId, sessionId } = await setupPublishedProperty(suffix);
  mockSession = {
    user: {
      id: guestId,
      hostProfileId: null,
      roles: ["guest"],
      sessionId,
      sessionVersion: 1,
    },
  };
  const idempotencyKey = crypto.randomUUID();

  const makeReq = () => new NextRequest("http://localhost/api/bookings", {
    method: "POST",
    headers: { "Idempotency-Key": idempotencyKey },
    body: JSON.stringify({ propertyId, checkIn: "2026-12-20", checkOut: "2026-12-22", guests: 1, guestName: "C Test", guestEmail: "c@test.host" }),
  });

  const first = await (await bookingsPOST(makeReq())).json();
  const second = await (await bookingsPOST(makeReq())).json();
  assert.equal(first.booking.id, second.booking.id, "the same idempotency key must return the same booking, not create a duplicate");

  const count = await db.query(`SELECT COUNT(*) FROM bookings WHERE idempotency_key = $1`, [idempotencyKey]);
  assert.equal(Number(count.rows[0].count), 1);
});

test("C: calling /api/payments/setup-intent twice for the same booking does not create a duplicate Stripe Customer or SetupIntent", async () => {
  process.env.ENABLE_DELAYED_CHARGE_BOOKINGS = "true";
  const suffix = crypto.randomBytes(4).toString("hex");
  const { propertyId, guestId, sessionId } = await setupPublishedProperty(suffix);
  mockSession = {
    user: {
      id: guestId,
      hostProfileId: null,
      roles: ["guest"],
      sessionId,
      sessionVersion: 1,
    },
  };

  const bookingReq = new NextRequest("http://localhost/api/bookings", {
    method: "POST",
    headers: { "Idempotency-Key": crypto.randomUUID() },
    body: JSON.stringify({ propertyId, checkIn: "2026-12-25", checkOut: "2026-12-27", guests: 1, guestName: "C2 Test", guestEmail: "c2@test.host" }),
  });
  const bookingData = await (await bookingsPOST(bookingReq)).json();

  let customerCreateCount = 0;
  let setupIntentCreateCount = 0;
  mockCustomerCreate = async () => { customerCreateCount++; return { id: `cus_test_${suffix}` }; };
  mockSetupIntentCreate = async () => {
    setupIntentCreateCount++;
    return routeSetupEvidence(bookingData.booking.id, "cus_test_" + suffix, "seti_test_" + suffix);
  };
  mockSetupIntentRetrieve = async () =>
    routeSetupEvidence(bookingData.booking.id, "cus_test_" + suffix, "seti_test_" + suffix);

  const makeReq = () => new NextRequest("http://localhost/api/payments/setup-intent", { method: "POST", body: JSON.stringify({ bookingId: bookingData.booking.id }) });
  const firstSetup = await setupIntentPOST(makeReq());
  const firstSetupData = await firstSetup.json();
  const secondSetup = await setupIntentPOST(makeReq());
  const secondSetupData = await secondSetup.json();
  assert.equal(firstSetup.status, 200);
  assert.equal(secondSetup.status, 200);
  assert.equal(firstSetupData.success, true);
  assert.equal(secondSetupData.success, true);
  assert.equal(secondSetupData.clientSecret, firstSetupData.clientSecret);

  assert.equal(customerCreateCount, 1, "the second call must reuse the already-saved Stripe Customer, not create a duplicate");
  assert.equal(setupIntentCreateCount, 1, "the second call must reuse the already-saved SetupIntent, not create a duplicate");

  delete process.env.ENABLE_DELAYED_CHARGE_BOOKINGS;
});

test("GET /api/bookings/[id] exposes paymentFlowVersion explicitly, so the client never has to infer it", async () => {
  const suffix = crypto.randomBytes(4).toString("hex");
  const { propertyId, guestId, sessionId } = await setupPublishedProperty(suffix);
  mockSession = {
    user: {
      id: guestId,
      hostProfileId: null,
      roles: ["guest"],
      sessionId,
      sessionVersion: 1,
    },
  };

  const bookingReq = new NextRequest("http://localhost/api/bookings", {
    method: "POST",
    headers: { "Idempotency-Key": crypto.randomUUID() },
    body: JSON.stringify({ propertyId, checkIn: "2026-12-28", checkOut: "2026-12-30", guests: 1, guestName: "D Test", guestEmail: "d@test.host" }),
  });
  const bookingData = await (await bookingsPOST(bookingReq)).json();

  const detailRes = await bookingDetailGET(new NextRequest(`http://localhost/api/bookings/${bookingData.booking.id}`), { params: Promise.resolve({ id: bookingData.booking.id }) });
  const detailData = await detailRes.json();
  assert.equal(detailData.booking.paymentFlowVersion, "destination_charge_legacy");
});

test("Setup route safety: uncertain creation retains ownership and returns safe guidance", async () => {
  const previousGate = process.env.ENABLE_DELAYED_CHARGE_BOOKINGS;
  process.env.ENABLE_DELAYED_CHARGE_BOOKINGS = "true";
  try {
    const suffix = crypto.randomBytes(8).toString("hex");
    const { propertyId, guestId, sessionId } = await setupPublishedProperty(suffix);
    mockSession = { user: {
      id: guestId, hostProfileId: null, roles: ["guest"],
      sessionId, sessionVersion: 1,
    } };
    const booking = (await db.query(
      "INSERT INTO bookings (property_id,guest_id,host_id,check_in,check_out,guests,status,guest_name,guest_email,cancellation_policy_snapshot,payment_flow_version,stripe_customer_id) " +
      "SELECT id,$2,host_id,'2027-06-01','2027-06-03',1,'pending_payment','Route Guest','route@test.host','[]','separate_charges_delayed_v1',$3 FROM properties WHERE id = $1 RETURNING id",
      [propertyId, guestId, "cus_route_" + suffix]
    )).rows[0];
    let creates = 0;
    mockCustomerCreate = async () => { throw new Error("Unexpected customer creation"); };
    mockPaymentIntentCreate = async () => { throw new Error("Unexpected payment creation"); };
    mockSetupIntentCreate = async () => {
      creates++;
      throw new Error("fixture_provider_internal_detail_" + suffix);
    };
    const request = () => new NextRequest("http://localhost/api/payments/setup-intent", {
      method: "POST", body: JSON.stringify({ bookingId: booking.id }),
    });
    const first = await setupIntentPOST(request());
    const firstData = await first.json();
    const second = await setupIntentPOST(request());
    const secondData = await second.json();

    assert.equal(creates, 1, "Uncertain response must not authorize another creation");
    for (const response of [first, second]) assert.equal(response.status, 400);
    const rows = (await db.query(
      "SELECT action FROM audit_log WHERE object_type = 'booking' AND object_id = $1",
      [booking.id]
    )).rows;
    assert.equal(rows.filter(row => row.action === "setup_intent_creation_reserved").length, 1);
    assert.equal(rows.filter(row => row.action === "setup_intent_creation_completed").length, 0);
    assert.equal((await db.query(
      "SELECT stripe_setup_intent_id FROM bookings WHERE id = $1", [booking.id]
    )).rows[0].stripe_setup_intent_id, null);

    for (const data of [firstData, secondData]) {
      assert.equal(data.success, false);
      assert.equal(data.error.code, "SETUP_INTENT_FAILED");
      assert.equal(data.clientSecret, undefined);
      assert.equal(data.error.message,
        "We couldn't complete payment setup. Check your trip status and contact HOST before trying again.");
      assert.doesNotMatch(JSON.stringify(data), /fixture_provider_internal_detail|creation_reserved|cus_route_/);
    }
  } finally {
    mockSession = null;
    if (previousGate === undefined) delete process.env.ENABLE_DELAYED_CHARGE_BOOKINGS;
    else process.env.ENABLE_DELAYED_CHARGE_BOOKINGS = previousGate;
  }
});
