export type LegacyIntentRecoveryIdentity = {
  bookingId: string;
  paymentId: string;
  creationId: string;
  providerIntentId: string;
  amountMinor: number;
  currency: string;
  applicationFeeMinor: number;
  destinationAccountId: string;
};

/** Strict test-mode evidence check only. Does not authorize creation,
 * confirmation, inventory restoration or clearing a reservation. */
export function legacyIntentRecoveryEvidenceMatches(
  identity: LegacyIntentRecoveryIdentity,
  evidence: unknown,
): boolean {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (![identity.bookingId, identity.paymentId, identity.creationId].every(
    value => typeof value === "string" && uuid.test(value)
  ) || !/^pi_[A-Za-z0-9_]+$/.test(identity.providerIntentId) ||
    !/^acct_[A-Za-z0-9_]+$/.test(identity.destinationAccountId) ||
    !Number.isSafeInteger(identity.amountMinor) || identity.amountMinor <= 0 ||
    !Number.isSafeInteger(identity.applicationFeeMinor) ||
    identity.applicationFeeMinor < 0 ||
    identity.applicationFeeMinor > identity.amountMinor ||
    !/^[A-Za-z]{3}$/.test(identity.currency)) return false;

  if (!evidence || typeof evidence !== "object") return false;
  const intent = evidence as Record<string, any>;
  const statuses = [
    "requires_payment_method", "requires_confirmation", "requires_action",
    "processing", "succeeded", "canceled",
  ];
  if (intent.object !== "payment_intent" ||
      intent.id !== identity.providerIntentId ||
      intent.livemode !== false ||
      !statuses.includes(intent.status) ||
      intent.amount !== identity.amountMinor ||
      intent.currency !== identity.currency.toLowerCase() ||
      intent.application_fee_amount !== identity.applicationFeeMinor ||
      intent.on_behalf_of != null ||
      intent.capture_method !== "automatic" ||
      intent.amount_capturable !== 0) return false;

  const destination = intent.transfer_data?.destination;
  const destinationId = typeof destination === "string"
    ? destination : destination?.id;
  if (destinationId !== identity.destinationAccountId ||
      intent.transfer_data?.amount != null ||
      intent.metadata?.booking_id !== identity.bookingId ||
      intent.metadata?.host_payment_id !== identity.paymentId ||
      intent.metadata?.host_payment_creation_id !== identity.creationId) return false;

  return intent.amount_received === (
    intent.status === "succeeded" ? identity.amountMinor : 0
  );
}
