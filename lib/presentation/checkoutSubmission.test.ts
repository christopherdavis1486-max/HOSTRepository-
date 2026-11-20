import test from "node:test";
import assert from "node:assert/strict";
import { checkLegacyCheckoutSubmission } from "./checkoutSubmission";

const ID = "d141aa91-4d4d-423c-9eb1-f76bc5641d29";
const base = {
  id: ID, status: "pending_payment",
  paymentFlowVersion: "destination_charge_legacy",
  checkoutHoldExpired: false, paymentStatus: "pending",
};
function fake(booking: Record<string, unknown>, status = 200): typeof fetch {
  return (async () => new Response(JSON.stringify({ success: true, booking }), {
    status, headers: { "Content-Type": "application/json" },
  })) as typeof fetch;
}

test("active legacy checkout uses a fresh authenticated request", async () => {
  let calls = 0;
  const fetcher: typeof fetch = async (url, options) => {
    calls++;
    assert.equal(url, "/api/bookings/" + ID);
    assert.equal(options?.credentials, "include");
    assert.equal(options?.cache, "no-store");
    return new Response(JSON.stringify({ success: true, booking: base }));
  };
  assert.equal((await checkLegacyCheckoutSubmission(ID, fetcher)).allowed, true);
  assert.equal(calls, 1);
});

test("expired hold is blocked with expiry guidance", async () => {
  const result = await checkLegacyCheckoutSubmission(ID, fake({ ...base, checkoutHoldExpired: true }));
  assert.equal(result.allowed, false);
  if (!result.allowed) assert.match(result.message, /hold has expired/);
});

for (const status of ["cancelled", "confirmed", "completed", "refunded"]) {
  test("booking status blocks stale checkout: " + status, async () => {
    assert.equal((await checkLegacyCheckoutSubmission(ID, fake({ ...base, status }))).allowed, false);
  });
}

test("missing expiry evidence, wrong identity and wrong flow fail closed", async () => {
  for (const override of [
    { checkoutHoldExpired: undefined },
    { id: "another-booking" },
    { paymentFlowVersion: "separate_charges_delayed_v1" },
  ]) {
    assert.equal((await checkLegacyCheckoutSubmission(ID, fake({ ...base, ...override }))).allowed, false);
  }
});

test("paid or uncertain payment outcomes block confirmation", async () => {
  for (const paymentStatus of ["paid", "processing", "refunded", null]) {
    assert.equal((await checkLegacyCheckoutSubmission(ID, fake({ ...base, paymentStatus }))).allowed, false);
  }
});

test("authorization errors, server errors, invalid JSON and network failure block confirmation", async () => {
  for (const status of [401, 403, 404, 500]) {
    assert.equal((await checkLegacyCheckoutSubmission(ID, fake(base, status))).allowed, false);
  }
  const invalid: typeof fetch = async () => new Response("invalid JSON");
  const offline: typeof fetch = async () => { throw new Error("offline"); };
  assert.equal((await checkLegacyCheckoutSubmission(ID, invalid)).allowed, false);
  assert.equal((await checkLegacyCheckoutSubmission(ID, offline)).allowed, false);
});

test("an unsuccessful API envelope cannot authorize confirmation", async () => {
  const fetcher: typeof fetch = async () => new Response(JSON.stringify({
    success: false, booking: base,
  }));
  assert.equal((await checkLegacyCheckoutSubmission(ID, fetcher)).allowed, false);
});
