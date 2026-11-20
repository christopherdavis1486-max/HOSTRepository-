/** Read-only submission guidance. Provider ownership and charge guards
 * remain authoritative; this snapshot is not an execution reservation. */
export function isSetupSubmissionEligible(row: {
  status: unknown;
  payment_flow_version: unknown;
  archived_at: unknown;
  stripe_customer_id: unknown;
  stripe_setup_intent_id: unknown;
  stripe_payment_method_id: unknown;
  grace_period_started_at: unknown;
  setup_hold_active: unknown;
  has_any_payment_attempt: unknown;
  has_unresolved_setup_creation: unknown;
  has_legacy_payment: unknown;
  has_successful_attempt: unknown;
  has_entitlement: unknown;
}): boolean {
  return row.status === "pending_payment" &&
    row.payment_flow_version === "separate_charges_delayed_v1" &&
    row.archived_at === null &&
    typeof row.stripe_customer_id === "string" &&
    /^cus_[A-Za-z0-9_]+$/.test(row.stripe_customer_id) &&
    typeof row.stripe_setup_intent_id === "string" &&
    /^seti_[A-Za-z0-9_]+$/.test(row.stripe_setup_intent_id) &&
    row.stripe_payment_method_id === null &&
    row.grace_period_started_at === null &&
    row.setup_hold_active === true &&
    row.has_any_payment_attempt === false &&
    row.has_unresolved_setup_creation === false &&
    row.has_legacy_payment === false &&
    row.has_successful_attempt === false &&
    row.has_entitlement === false;
}
