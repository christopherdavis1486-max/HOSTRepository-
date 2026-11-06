import { test, mock, before } from "node:test";
import assert from "node:assert/strict";


const refundId = "re_test_refund123";
const paymentIntentId = "pi_test_payment123";
const amountMinor = 24000;
const currency = "gbp";
const expectedHostRefundId = "123e4567-e89b-42d3-a456-426614174000";
let verifyRefund: typeof import("./newFlowStripeRefundVerification").verifyNewFlowStripeRefund; let mockRetrieve: (refundId: string) => Promise<any>;
let mockList: (params: any) => Promise<any>;

before(async () => { mock.module("./stripeClient", {
  namedExports: {
    stripe: {
      refunds: {
        retrieve: async (id: string) => mockRetrieve(id),
        list: async (params: any) => mockList(params),
      },
    },
  },
});

({ verifyNewFlowStripeRefund: verifyRefund } =
  await import("./newFlowStripeRefundVerification")); });

test("successful refund is verified against the expected payment", async () => {
  mockRetrieve = async () => ({
    metadata: { host_refund_id: expectedHostRefundId },
    id: refundId,
    payment_intent: paymentIntentId,
    amount: amountMinor,
    currency,
    status: "succeeded",
  });

  const result = await verifyRefund(refundId, paymentIntentId, amountMinor, currency, expectedHostRefundId);

  assert.deepEqual(result, {
    outcome: "succeeded",
    refundId,
  });
});
test("pending Stripe refund remains pending", async () => {
  mockRetrieve = async () => ({
    metadata: { host_refund_id: expectedHostRefundId },
    id: refundId,
    payment_intent: paymentIntentId,
    amount: amountMinor,
    currency,
    status: "pending",
  });

  const result = await verifyRefund(refundId, paymentIntentId, amountMinor, currency, expectedHostRefundId);
  assert.deepEqual(result, { outcome: "pending", refundId });
});

test("failed Stripe refund is recognised", async () => {
  mockRetrieve = async () => ({
    metadata: { host_refund_id: expectedHostRefundId },
    id: refundId,
    payment_intent: paymentIntentId,
    amount: amountMinor,
    currency,
    status: "failed",
  });

  const result = await verifyRefund(refundId, paymentIntentId, amountMinor, currency, expectedHostRefundId);
  assert.deepEqual(result, { outcome: "failed", refundId });
});
test("refund belonging to another payment is rejected", async () => {
  mockRetrieve = async () => ({
    metadata: { host_refund_id: expectedHostRefundId },
    id: refundId,
    payment_intent: "pi_different_payment",
    amount: amountMinor,
    currency,
    status: "succeeded",
  });

  const result = await verifyRefund(refundId, paymentIntentId, amountMinor, currency, expectedHostRefundId);

  assert.deepEqual(result, {
    outcome: "unknown",
    reason: "Refund payment details mismatch",
  });
});
test("refund with incorrect amount is rejected", async () => {
  mockRetrieve = async () => ({
    metadata: { host_refund_id: expectedHostRefundId },
    id: refundId,
    payment_intent: paymentIntentId,
    amount: 20000,
    currency,
    status: "succeeded",
  });

  const result = await verifyRefund(refundId, paymentIntentId, amountMinor, currency, expectedHostRefundId);

  assert.deepEqual(result, {
    outcome: "unknown",
    reason: "Refund payment details mismatch",
  });
});
test("refund with incorrect currency is rejected", async () => {
  mockRetrieve = async () => ({
    metadata: { host_refund_id: expectedHostRefundId },
    id: refundId,
    payment_intent: paymentIntentId,
    amount: amountMinor,
    currency: "eur",
    status: "succeeded",
  });

  const result = await verifyRefund(refundId, paymentIntentId, amountMinor, currency, expectedHostRefundId);

  assert.deepEqual(result, {
    outcome: "unknown",
    reason: "Refund payment details mismatch",
  });
});
test("cancelled Stripe refund is recognised", async () => {
  mockRetrieve = async () => ({
    metadata: { host_refund_id: expectedHostRefundId },
    id: refundId,
    payment_intent: paymentIntentId,
    amount: amountMinor,
    currency,
    status: "canceled",
  });

  const result = await verifyRefund(refundId, paymentIntentId, amountMinor, currency, expectedHostRefundId);

  assert.deepEqual(result, {
    outcome: "failed",
    refundId,
  });
});
test("Stripe API failure produces an unknown outcome", async () => {
  mockRetrieve = async () => {
    throw new Error("Simulated Stripe connection failure");
  };

  const result = await verifyRefund(refundId, paymentIntentId, amountMinor, currency, expectedHostRefundId);

  assert.deepEqual(result, {
    outcome: "unknown",
    reason: "Stripe refund lookup unavailable",
  });
});
test("reconciliation finds a matching refund on the second page", async () => {
  const hostRefundId = "123e4567-e89b-42d3-a456-426614174000";
  const { findNewFlowStripeRefund } = await import("./newFlowStripeRefundVerification");
  const cursors: Array<string | undefined> = [];

  mockList = async (params: any) => {
    cursors.push(params.starting_after);
    assert.equal(params.payment_intent, paymentIntentId);
    assert.equal(params.limit, 100);

    if (!params.starting_after) {
      return {
        data: [{ id: "re_first_page", metadata: { host_refund_id: "other" } }],
        has_more: true,
      };
    }

    assert.equal(params.starting_after, "re_first_page");
    return {
      data: [{ id: "re_second_page", payment_intent: paymentIntentId, amount: amountMinor, currency, metadata: { host_refund_id: hostRefundId } }],
      has_more: false,
    };
  };

  const result = await findNewFlowStripeRefund(hostRefundId, paymentIntentId, amountMinor, currency);

  assert.deepEqual(result, { outcome: "found", refundId: "re_second_page" });
  assert.deepEqual(cursors, [undefined, "re_first_page"]);
});
test("reconciliation rejects duplicate refunds across pages", async () => {
  const hostRefundId = "123e4567-e89b-42d3-a456-426614174000";
  const { findNewFlowStripeRefund } = await import("./newFlowStripeRefundVerification");
  let calls = 0;

  mockList = async (params: any) => {
    calls++;

    if (!params.starting_after) {
      return {
        data: [{
          id: "re_first_match",
          payment_intent: paymentIntentId, amount: amountMinor, currency,
          metadata: { host_refund_id: hostRefundId },
        }],
        has_more: true,
      };
    }

    assert.equal(params.starting_after, "re_first_match");

    return {
      data: [{
        id: "re_second_match",
        metadata: { host_refund_id: hostRefundId },
      }],
      has_more: false,
    };
  };

  const result = await findNewFlowStripeRefund(hostRefundId, paymentIntentId, amountMinor, currency);

  assert.deepEqual(result, {
    outcome: "unknown",
    reason: "Multiple matching Stripe refunds",
  });
  assert.equal(calls, 2);
});
test("incomplete Stripe pagination requires reconciliation", async () => {
  const hostRefundId = "123e4567-e89b-42d3-a456-426614174000";
  const { findNewFlowStripeRefund } = await import("./newFlowStripeRefundVerification");

  mockList = async () => ({
    data: [],
    has_more: true,
  });

  const result = await findNewFlowStripeRefund(hostRefundId, paymentIntentId, amountMinor, currency);

  assert.deepEqual(result, {
    outcome: "unknown",
    reason: "Stripe pagination incomplete",
  });
});
test("Stripe failure after a matching page requires reconciliation", async () => {
  const hostRefundId = "123e4567-e89b-42d3-a456-426614174000";
  const { findNewFlowStripeRefund } = await import("./newFlowStripeRefundVerification");
  let calls = 0;

  mockList = async (params: any) => {
    calls++;

    if (!params.starting_after) {
      return {
        data: [{
          id: "re_first_match",
          payment_intent: paymentIntentId, amount: amountMinor, currency,
          metadata: { host_refund_id: hostRefundId },
        }],
        has_more: true,
      };
    }

    throw new Error("Simulated Stripe connection failure");
  };

  const result = await findNewFlowStripeRefund(hostRefundId, paymentIntentId, amountMinor, currency);

  assert.deepEqual(result, {
    outcome: "unknown",
    reason: "Stripe reconciliation lookup unavailable",
  });
  assert.equal(calls, 2);
});
test("refund with incorrect Stripe refund ID is rejected", async () => {
  mockRetrieve = async () => ({
    metadata: { host_refund_id: expectedHostRefundId },
    id: "re_different_refund",
    payment_intent: paymentIntentId,
    amount: amountMinor,
    currency,
    status: "succeeded",
  });

  const result = await verifyRefund(refundId, paymentIntentId, amountMinor, currency, expectedHostRefundId);

  assert.deepEqual(result, {
    outcome: "unknown",
    reason: "Refund payment details mismatch",
  });
});
test("reconciliation rejects a refund with an incorrect amount", async () => {
  const hostRefundId = "123e4567-e89b-42d3-a456-426614174000";
  const { findNewFlowStripeRefund } = await import("./newFlowStripeRefundVerification");

  mockList = async () => ({
    data: [{
      id: "re_wrong_amount",
      payment_intent: paymentIntentId,
      amount: amountMinor - 1000,
      currency,
      metadata: { host_refund_id: hostRefundId },
    }],
    has_more: false,
  });

  const result = await findNewFlowStripeRefund(
    hostRefundId,
    paymentIntentId,
    amountMinor,
    currency
  );

  assert.deepEqual(result, {
    outcome: "unknown",
    reason: "Reconciled refund payment details mismatch",
  });
});
test("reconciliation rejects a refund with an incorrect currency", async () => {
  const hostRefundId = "123e4567-e89b-42d3-a456-426614174000";
  const { findNewFlowStripeRefund } = await import("./newFlowStripeRefundVerification");

  mockList = async () => ({
    data: [{
      id: "re_wrong_currency",
      payment_intent: paymentIntentId,
      amount: amountMinor,
      currency: "eur",
      metadata: { host_refund_id: hostRefundId },
    }],
    has_more: false,
  });

  const result = await findNewFlowStripeRefund(
    hostRefundId,
    paymentIntentId,
    amountMinor,
    currency
  );

  assert.deepEqual(result, {
    outcome: "unknown",
    reason: "Reconciled refund payment details mismatch",
  });
});
test("reconciliation rejects a repeating pagination cursor cycle", async () => {
  const hostRefundId = "123e4567-e89b-42d3-a456-426614174000";
  const { findNewFlowStripeRefund } = await import("./newFlowStripeRefundVerification");

  let calls = 0;

  mockList = async () => {
    calls++;
    if (calls > 3) {
      throw new Error("Unexpected fourth pagination request");
    }

    return {
      data: [{ id: calls % 2 === 1 ? "re_page_a" : "re_page_b" }],
      has_more: true,
    };
  };

  const result = await findNewFlowStripeRefund(
    hostRefundId,
    paymentIntentId,
    amountMinor,
    currency
  );

  assert.deepEqual(result, {
    outcome: "unknown",
    reason: "Stripe pagination incomplete",
  });
  assert.equal(calls, 3);
});

test("refund belonging to another HOST refund record is rejected", async () => {
  mockRetrieve = async () => ({
    id: refundId,
    payment_intent: paymentIntentId,
    amount: amountMinor,
    currency,
    metadata: {
      host_refund_id: "123e4567-e89b-42d3-a456-426614174999"
    },
    status: "succeeded"
  });

  const result = await verifyRefund(
    refundId,
    paymentIntentId,
    amountMinor,
    currency,
    expectedHostRefundId
  );

  assert.deepEqual(result, {
    outcome: "unknown",
    reason: "Refund payment details mismatch"
  });
});

test("refund lookup rejects missing pagination metadata", async () => {
  const { findNewFlowStripeRefund } = await import("./newFlowStripeRefundVerification");
  for (const page of [{ data: [] }, { data: [], has_more: "false" }, { has_more: false }]) {
    mockList = async () => page;
    const result = await findNewFlowStripeRefund(
      expectedHostRefundId, paymentIntentId, amountMinor, currency
    );
    assert.deepEqual(result, {
      outcome: "unknown", reason: "Stripe pagination metadata invalid"
    });
  }
});

test("refund lookup stops at its pagination limit without declaring absence", async () => {
  const { findNewFlowStripeRefund } = await import("./newFlowStripeRefundVerification");
  let calls = 0;
  mockList = async () => ({
    data: [{ id: "re_page_" + (++calls), metadata: {} }],
    has_more: true
  });
  const result = await findNewFlowStripeRefund(
    expectedHostRefundId, paymentIntentId, amountMinor, currency
  );
  assert.deepEqual(result, {
    outcome: "unknown", reason: "Stripe pagination limit exceeded"
  });
  assert.equal(calls, 100);
});
