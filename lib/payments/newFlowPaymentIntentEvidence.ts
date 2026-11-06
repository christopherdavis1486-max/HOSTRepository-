import type Stripe from "stripe";

export type NewFlowPaymentExpectation = {
  bookingId: string;
  attemptId: string;
  customerId: string;
  amountMinor: number;
  currency: string;
  providerPaymentIntentId?: string;
};

/** Validates provider evidence only; performs no database or provider operations. */
export function newFlowPaymentIntentEvidenceMatches(
  intent: Stripe.PaymentIntent,
  expected: NewFlowPaymentExpectation
): boolean {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuid.test(expected.bookingId) || !uuid.test(expected.attemptId) ||
      !/^cus_[A-Za-z0-9_]+$/.test(expected.customerId) ||
      !Number.isSafeInteger(expected.amountMinor) || expected.amountMinor <= 0 ||
      !/^[A-Za-z]{3}$/.test(expected.currency)) return false;
  if (!intent || typeof intent.id !== "string" ||
      !/^pi_[A-Za-z0-9_]+$/.test(intent.id) ||
      (expected.providerPaymentIntentId !== undefined &&
       intent.id !== expected.providerPaymentIntentId)) return false;
  const customer = typeof intent.customer === "string"
    ? intent.customer : intent.customer?.id;
  if (customer !== expected.customerId ||
      intent.amount !== expected.amountMinor ||
      typeof intent.currency !== "string" ||
      intent.currency.toLowerCase() !== expected.currency.toLowerCase() ||
      intent.metadata?.booking_id !== expected.bookingId ||
      intent.metadata?.payment_attempt_id !== expected.attemptId ||
      intent.metadata?.payment_flow_version !== "separate_charges_delayed_v1") return false;
  if (intent.status === "succeeded") {
    return intent.amount_received === expected.amountMinor &&
      intent.amount_capturable === 0;
  }
  if (intent.status === "canceled") {
    return intent.amount_received === 0 && intent.amount_capturable === 0;
  }
  return true;
}
