export type SetupIntentExpectation = {
  bookingId: string;
  customerId: string;
  setupIntentId?: string;
  requireClientSecret: boolean;
};

/** Validates provider evidence only; never authorizes a payment charge. */
export function setupIntentEvidenceMatches(
  evidence: unknown,
  expected: SetupIntentExpectation,
): boolean {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuid.test(expected.bookingId) ||
      !/^cus_[A-Za-z0-9_]+$/.test(expected.customerId) ||
      (expected.setupIntentId !== undefined &&
       !/^seti_[A-Za-z0-9_]+$/.test(expected.setupIntentId))) return false;
  if (!evidence || typeof evidence !== "object") return false;
  const intent = evidence as Record<string, any>;
  const customer = typeof intent.customer === "string"
    ? intent.customer : intent.customer?.id;
  const reusable = ["requires_payment_method", "requires_confirmation", "requires_action"];
  if (intent.object !== "setup_intent" ||
      typeof intent.id !== "string" || !/^seti_[A-Za-z0-9_]+$/.test(intent.id) ||
      (expected.setupIntentId !== undefined && intent.id !== expected.setupIntentId) ||
      customer !== expected.customerId || intent.customer?.deleted === true ||
      intent.metadata?.booking_id !== expected.bookingId ||
      intent.usage !== "off_session" ||
      ![...reusable, "succeeded", "canceled"].includes(intent.status)) return false;
  if (!expected.requireClientSecret) return true;
  if (!reusable.includes(intent.status) || typeof intent.client_secret !== "string") return false;
  const prefix = intent.id + "_secret_";
  return intent.client_secret.startsWith(prefix) &&
    /^[A-Za-z0-9_]+$/.test(intent.client_secret.slice(prefix.length));
}
