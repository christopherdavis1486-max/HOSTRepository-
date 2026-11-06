export type RefundDisplayStatus =
  | "refund_requested" | "refund_processing" | "refund_needs_review"
  | "refund_failed" | "refunded" | "partially_refunded";

export type RefundDisplayEvidence = {
  status: string;
  reconciliation_required: boolean;
  amount_minor: number;
  currency: string;
  provider_refund_id: string | null;
  payment_status: string | null;
  payment_amount_minor: number | null;
  payment_currency: string | null;
};

/** Display only. Does not verify a provider, authorize execution or alter records. */
export function deriveNewFlowRefundDisplay(
  refunds: RefundDisplayEvidence[]
): RefundDisplayStatus | null {
  if (refunds.length === 0) return null;
  if (refunds.length !== 1) return "refund_needs_review";
  const r = refunds[0];
  const currency = String(r.currency ?? "").trim().toUpperCase();
  if (r.payment_status !== "succeeded" ||
      !Number.isSafeInteger(r.amount_minor) || r.amount_minor <= 0 ||
      !Number.isSafeInteger(r.payment_amount_minor) ||
      r.payment_amount_minor === null || r.payment_amount_minor <= 0 ||
      r.amount_minor > r.payment_amount_minor ||
      !/^[A-Z]{3}$/.test(currency) ||
      currency !== String(r.payment_currency ?? "").trim().toUpperCase() ||
      r.reconciliation_required !== false) return "refund_needs_review";
  if (r.status === "succeeded") {
    if (!/^re_[A-Za-z0-9_]+$/.test(r.provider_refund_id ?? "")) {
      return "refund_needs_review";
    }
    return r.amount_minor === r.payment_amount_minor ? "refunded" : "partially_refunded";
  }
  if (r.provider_refund_id !== null) return "refund_needs_review";
  if (r.status === "pending") return "refund_requested";
  if (r.status === "processing") return "refund_processing";
  if (r.status === "failed") return "refund_failed";
  return "refund_needs_review";
}

// Correlated with the caller's bookings alias b. Legacy bookings return no evidence.
export const newFlowRefundDisplaySql = `(
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'status', r.status, 'reconciliation_required', r.reconciliation_required,
    'amount_minor', r.amount_minor, 'currency', r.currency,
    'provider_refund_id', r.provider_refund_id,
    'payment_status', p.status, 'payment_amount_minor', p.amount_minor,
    'payment_currency', p.currency
  ) ORDER BY r.id), '[]'::jsonb)
  FROM new_flow_refunds r
  LEFT JOIN payment_attempts p ON p.id = r.payment_attempt_id AND p.booking_id = r.booking_id
  WHERE r.booking_id = b.id AND b.payment_flow_version = 'separate_charges_delayed_v1'
)`;
