export type LegacyUnpaidIntentExpected = {
  bookingId: string;
  paymentId: string;
  providerPaymentIntentId: string;
  amountMinor: number;
  currency: string;
  destinationAccountId: string;
  applicationFeeMinor: number;
};

export type LegacyUnpaidIntentDecision =
  | { outcome: "cancelable" }
  | { outcome: "cancelled_unpaid" }
  | { outcome: "blocked"; reason: string };

/** Provider evidence only. Does not authorize booking eligibility or write state. */
export function inspectLegacyUnpaidIntent(
  expected: LegacyUnpaidIntentExpected,
  intent: unknown
): LegacyUnpaidIntentDecision {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuid.test(expected.bookingId) || !uuid.test(expected.paymentId) ||
      !/^pi_[A-Za-z0-9_]+$/.test(expected.providerPaymentIntentId) ||
      !/^acct_[A-Za-z0-9_]+$/.test(expected.destinationAccountId) ||
      !Number.isSafeInteger(expected.amountMinor) || expected.amountMinor <= 0 ||
      !Number.isSafeInteger(expected.applicationFeeMinor) ||
      expected.applicationFeeMinor < 0 ||
      expected.applicationFeeMinor > expected.amountMinor ||
      !/^[A-Za-z]{3}$/.test(expected.currency)) {
    return { outcome: "blocked", reason: "Invalid stored payment evidence" };
  }
  if (!intent || typeof intent !== "object") {
    return { outcome: "blocked", reason: "Missing provider evidence" };
  }

  const value = intent as Record<string, any>;
  const destination = typeof value.transfer_data?.destination === "string"
    ? value.transfer_data.destination : value.transfer_data?.destination?.id;
  if (value.id !== expected.providerPaymentIntentId ||
      value.object !== "payment_intent" ||
      value.metadata?.booking_id !== expected.bookingId ||
      value.metadata?.host_payment_id !== expected.paymentId ||
      value.amount !== expected.amountMinor ||
      typeof value.currency !== "string" ||
      value.currency !== expected.currency.toLowerCase() ||
      destination !== expected.destinationAccountId ||
      value.application_fee_amount !== expected.applicationFeeMinor ||
      (value.metadata?.payment_flow_version !== undefined &&
       value.metadata.payment_flow_version !== "destination_charge_legacy")) {
    return { outcome: "blocked", reason: "Provider payment evidence mismatch" };
  }

  if (value.amount_received !== 0 || value.amount_capturable !== 0) {
    return { outcome: "blocked", reason: "Payment is not proven uncollected" };
  }
  if (value.status === "canceled") return { outcome: "cancelled_unpaid" };
  if (["requires_payment_method", "requires_confirmation", "requires_action"]
      .includes(value.status)) {
    return { outcome: "cancelable" };
  }
  return { outcome: "blocked", reason: "Provider status requires review" };
}
