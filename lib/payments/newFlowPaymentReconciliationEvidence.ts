import type Stripe from "stripe";
import { stripe } from "./stripeClient";
import { newFlowPaymentIntentEvidenceMatches } from "./newFlowPaymentIntentEvidence";

export type PaymentReconciliationExpected = {
  bookingId: string;
  attemptId: string;
  customerId: string;
  amountMinor: number;
  currency: string;
  providerPaymentIntentId: string | null;
};
export type PaymentReconciliationEvidence =
  | { outcome: "succeeded"; intent: Stripe.PaymentIntent }
  | { outcome: "cancelled_unpaid"; intent: Stripe.PaymentIntent }
  | { outcome: "unresolved"; reason: string };

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Read-only lookup. Absence never proves nonpayment or permits charge replay. */
export async function inspectNewFlowPayment(
  expected: PaymentReconciliationExpected
): Promise<PaymentReconciliationEvidence> {
  if (!uuid.test(expected.bookingId) || !uuid.test(expected.attemptId) ||
      !/^cus_[A-Za-z0-9_]+$/.test(expected.customerId) ||
      !Number.isSafeInteger(expected.amountMinor) || expected.amountMinor <= 0 ||
      !/^[A-Za-z]{3}$/.test(expected.currency) ||
      (expected.providerPaymentIntentId !== null &&
        !/^pi_[A-Za-z0-9_]+$/.test(expected.providerPaymentIntentId))) {
    return { outcome: "unresolved", reason: "Invalid stored payment identifiers" };
  }
  try {
    let providerId = expected.providerPaymentIntentId;
    if (!providerId) {
      let found: Stripe.PaymentIntent | undefined;
      let cursor: string | undefined;
      let complete = false;
      const seen = new Set<string>();
      for (let pageNumber = 0; pageNumber < 100; pageNumber++) {
        const page = await stripe.paymentIntents.list({
          customer: expected.customerId, limit: 100,
          ...(cursor ? { starting_after: cursor } : {}),
        });
        if (!Array.isArray(page.data) || typeof page.has_more !== "boolean") {
          throw new Error("Invalid payment pagination metadata");
        }
        for (const candidate of page.data) {
          if (candidate.metadata?.payment_attempt_id === expected.attemptId) {
            if (found) throw new Error("Multiple payments match this attempt");
            found = candidate;
          }
        }
        if (!page.has_more) { complete = true; break; }
        const next = page.data.at(-1)?.id;
        if (!next || seen.has(next)) throw new Error("Incomplete payment pagination");
        seen.add(next);
        cursor = next;
      }
      if (!complete) throw new Error("Payment pagination limit reached");
      if (!found) {
        return { outcome: "unresolved", reason: "No matching payment found; execution remains blocked" };
      }
      providerId = found.id;
    }
    if (!/^pi_[A-Za-z0-9_]+$/.test(providerId)) {
      throw new Error("Invalid provider payment reference");
    }
    const intent = await stripe.paymentIntents.retrieve(providerId);
    if (!newFlowPaymentIntentEvidenceMatches(intent, {
      bookingId: expected.bookingId, attemptId: expected.attemptId,
      customerId: expected.customerId, amountMinor: expected.amountMinor,
      currency: expected.currency, providerPaymentIntentId: providerId,
    })) {
      throw new Error("Payment evidence mismatch");
    }
    if (intent.status === "succeeded" && intent.amount_received === expected.amountMinor) {
      return { outcome: "succeeded", intent };
    }
    if (intent.status === "canceled" && intent.amount_received === 0 &&
        intent.amount_capturable === 0) {
      return { outcome: "cancelled_unpaid", intent };
    }
    return { outcome: "unresolved", reason: "Payment remains unresolved: " + intent.status };
  } catch (error) {
    return {
      outcome: "unresolved",
      reason: error instanceof Error ? error.message : "Payment lookup unavailable",
    };
  }
}
