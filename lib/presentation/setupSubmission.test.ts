import test from "node:test";
import assert from "node:assert/strict";
import { checkSetupCheckoutSubmission } from "./setupSubmission";

const booking = {
  id: "booking-fixture",
  status: "pending_payment",
  paymentFlowVersion: "separate_charges_delayed_v1",
  archived: false,
  checkoutHoldExpired: false,
  canSubmitPaymentSetup: true,
};
function response(body: unknown, status = 200): typeof fetch {
  return (async () => new Response(JSON.stringify(body), {
    status, headers: { "Content-Type": "application/json" },
  })) as typeof fetch;
}

test("setup check uses a fresh authenticated request and explicit server eligibility", async () => {
  const fetcher = (async (url, options) => {
    assert.equal(url, "/api/bookings/booking-fixture");
    assert.equal(options?.credentials, "include");
    assert.equal(options?.cache, "no-store");
    return new Response(JSON.stringify({ success: true, booking }));
  }) as typeof fetch;
  assert.deepEqual(await checkSetupCheckoutSubmission(booking.id, fetcher), { allowed: true });
});

test("expired setup hold gives expiry guidance", async () => {
  const result = await checkSetupCheckoutSubmission(booking.id, response({
    success: true, booking: { ...booking, checkoutHoldExpired: true },
  }));
  assert.equal(result.allowed, false);
  if (!result.allowed) assert.match(result.message, /hold has expired/);
});

test("invalid identity, flow, lifecycle and missing eligibility block setup", async () => {
  for (const override of [
    { id: "different" }, { status: "cancelled" }, { status: "confirmed" },
    { status: "completed" }, { status: "refunded" },
    { paymentFlowVersion: "destination_charge_legacy" },
    { archived: true }, { archived: undefined },
    { checkoutHoldExpired: undefined },
    { canSubmitPaymentSetup: false }, { canSubmitPaymentSetup: undefined },
  ]) {
    const result = await checkSetupCheckoutSubmission(booking.id, response({
      success: true, booking: { ...booking, ...override },
    }));
    assert.equal(result.allowed, false, JSON.stringify(override));
  }
});

test("display labels cannot authorize setup without server eligibility", async () => {
  for (const guestPaymentStatus of [
    "payment_method_required", "payment_method_saved", "payment_grace_period",
  ]) {
    const result = await checkSetupCheckoutSubmission(booking.id, response({
      success: true,
      booking: { ...booking, canSubmitPaymentSetup: false, guestPaymentStatus },
    }));
    assert.equal(result.allowed, false);
  }
});

test("HTTP errors, unsuccessful envelopes, malformed JSON and network failures block setup", async () => {
  for (const status of [401, 403, 404, 500]) {
    assert.equal((await checkSetupCheckoutSubmission(
      booking.id, response({ success: true, booking }, status)
    )).allowed, false);
  }
  for (const body of [null, {}, { success: false, booking }]) {
    assert.equal((await checkSetupCheckoutSubmission(
      booking.id, response(body)
    )).allowed, false);
  }
  const malformed = (async () => new Response("invalid JSON")) as typeof fetch;
  const offline = (async () => { throw new Error("offline"); }) as typeof fetch;
  assert.equal((await checkSetupCheckoutSubmission(booking.id, malformed)).allowed, false);
  assert.equal((await checkSetupCheckoutSubmission(booking.id, offline)).allowed, false);
});
