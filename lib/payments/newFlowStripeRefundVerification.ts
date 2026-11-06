import { stripe } from "./stripeClient";

/**
 * Read-only Stripe refund verification for separate_charges_delayed_v1.
 *
 * Never creates refunds, reverses transfers, or retries payments.
 * Unknown outcomes must remain subject to reconciliation.
 */
export type NewFlowStripeRefundOutcome =
  | { outcome: "succeeded"; refundId: string }
  | { outcome: "pending"; refundId: string }
  | { outcome: "failed"; refundId: string }
  | { outcome: "unknown"; reason: string };
export async function verifyNewFlowStripeRefund(
  refundId: string,
  paymentIntentId: string,
  expectedAmountMinor: number,
  expectedCurrency: string,
  expectedHostRefundId: string
): Promise<NewFlowStripeRefundOutcome> {
  if (!/^re_[A-Za-z0-9_]+$/.test(refundId)) {
    return { outcome: "unknown", reason: "Invalid refund ID" };
  }

  if (!/^pi_[A-Za-z0-9_]+$/.test(paymentIntentId)) {
    return { outcome: "unknown", reason: "Invalid payment intent ID" };
  }

  if (!Number.isSafeInteger(expectedAmountMinor) || expectedAmountMinor <= 0) {
    return { outcome: "unknown", reason: "Invalid expected amount" };
  }

  if (!/^[a-zA-Z]{3}$/.test(expectedCurrency)) {
    return { outcome: "unknown", reason: "Invalid currency" };
  }

  try {
    const refund = await stripe.refunds.retrieve(refundId);

    if (
      refund.metadata?.host_refund_id !== expectedHostRefundId ||
      refund.id !== refundId ||
      refund.payment_intent !== paymentIntentId ||
      refund.amount !== expectedAmountMinor ||
      refund.currency.toLowerCase() !== expectedCurrency.toLowerCase()
    ) {
      return { outcome: "unknown", reason: "Refund payment details mismatch" };
    }

    switch (refund.status) {
      case "succeeded":
        return { outcome: "succeeded", refundId: refund.id };
      case "pending":
      case "requires_action":
        return { outcome: "pending", refundId: refund.id };
      case "failed":
      case "canceled":
        return { outcome: "failed", refundId: refund.id };
      default:
        return { outcome: "unknown", reason: "Unrecognised Stripe refund status" };
    }
  } catch {
    return { outcome: "unknown", reason: "Stripe refund lookup unavailable" };
  }
}
/**
 * Result of searching Stripe for a refund whose original response
 * was not received by HOST.
 *
 * "not_found" is informational only and never authorises a retry.
 */
export type NewFlowRefundLookupResult =
  | { outcome: "found"; refundId: string }
  | { outcome: "not_found" }
  | { outcome: "unknown"; reason: string };
export async function findNewFlowStripeRefund(
  hostRefundId: string,
  paymentIntentId: string,
  expectedAmountMinor: number,
  expectedCurrency: string
): Promise<NewFlowRefundLookupResult> {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(hostRefundId) ||
    !/^pi_[A-Za-z0-9_]+$/.test(paymentIntentId) ||
    !Number.isSafeInteger(expectedAmountMinor) ||
    expectedAmountMinor <= 0 ||
    !/^[a-zA-Z]{3}$/.test(expectedCurrency)
  ) {
    return { outcome: "unknown", reason: "Invalid reconciliation identifiers" };
  }

  let startingAfter: string | undefined;
  let foundRefundId: string | undefined;
  const seenCursors = new Set<string>();
  let pagesRead = 0;

  try {
    do {
      if (++pagesRead > 100) {
        return { outcome: "unknown", reason: "Stripe pagination limit exceeded" };
      }
      const page = await stripe.refunds.list({
        payment_intent: paymentIntentId,
        limit: 100,
        ...(startingAfter ? { starting_after: startingAfter } : {}),
      });

      if (!Array.isArray(page.data) || typeof page.has_more !== "boolean") {
        return { outcome: "unknown", reason: "Stripe pagination metadata invalid" };
      }

      const matching = page.data.filter(
        (refund) => refund.metadata?.host_refund_id === hostRefundId
      );

      if (matching.length > 1 || (matching.length === 1 && foundRefundId)) {
        return { outcome: "unknown", reason: "Multiple matching Stripe refunds" };
      }

      if (matching.length === 1) {
        const refund = matching[0];
        if (refund.payment_intent !== paymentIntentId || refund.amount !== expectedAmountMinor || refund.currency?.toLowerCase() !== expectedCurrency.toLowerCase()) {
          return { outcome: "unknown", reason: "Reconciled refund payment details mismatch" };
        }
        foundRefundId = refund.id;
      }

      if (!page.has_more) {
        return foundRefundId ? { outcome: "found", refundId: foundRefundId } : { outcome: "not_found" };
      }

      const lastId = page.data[page.data.length - 1]?.id;

      if (!lastId || seenCursors.has(lastId)) {
        return { outcome: "unknown", reason: "Stripe pagination incomplete" };
      }

      seenCursors.add(lastId);
      startingAfter = lastId;
    } while (true);
  } catch {
    return { outcome: "unknown", reason: "Stripe reconciliation lookup unavailable" };
  }
}
