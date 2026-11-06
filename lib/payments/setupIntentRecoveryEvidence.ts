export type SetupIntentRecoveryIdentity = {
  bookingId: string;
  customerId: string;
  creationId: string;
  providerIntentId: string;
};

/** Test-mode reference evidence only. Grants no creation or charge authority. */
export function setupIntentRecoveryEvidenceMatches(
  identity: SetupIntentRecoveryIdentity,
  evidence: unknown,
): boolean {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!identity ||
      ![identity.bookingId, identity.creationId].every(
        value => typeof value === "string" && uuid.test(value)
      ) ||
      typeof identity.customerId !== "string" ||
      !/^cus_[A-Za-z0-9_]+$/.test(identity.customerId) ||
      typeof identity.providerIntentId !== "string" ||
      !/^seti_[A-Za-z0-9_]+$/.test(identity.providerIntentId)) return false;
  if (!evidence || typeof evidence !== "object") return false;
  const intent = evidence as Record<string, any>;
  const customer = intent.customer;
  const customerId = typeof customer === "string" ? customer : customer?.id;
  if (typeof customer !== "string" &&
      (!customer || customer.object !== "customer" ||
       customer.deleted === true || customer.livemode !== false)) return false;
  if (intent.object !== "setup_intent" ||
      intent.id !== identity.providerIntentId ||
      intent.livemode !== false ||
      customerId !== identity.customerId ||
      intent.metadata?.booking_id !== identity.bookingId ||
      intent.metadata?.host_setup_creation_id !== identity.creationId ||
      intent.usage !== "off_session" ||
      !["requires_payment_method", "requires_confirmation", "requires_action",
        "processing", "succeeded", "canceled"].includes(intent.status)) return false;

  const method = intent.payment_method;
  if (method != null &&
      (typeof method !== "string" || !/^pm_[A-Za-z0-9_]+$/.test(method))) return false;
  if (intent.status === "succeeded" && method == null) return false;
  return true;
}
