import type { PoolClient } from "pg";

/** Caller holds booking, payment and refund locks.
 * Locks supporting authorization evidence; never contacts a provider.
 */
export async function hasNewFlowRefundAuthorization(
  client: PoolClient, refundId: string
): Promise<boolean> {
  const result = await client.query(
    `SELECT r.*, b.status AS booking_status, b.payment_flow_version,
            b.hold_expires_at, b.host_id,
            p.status AS payment_status, p.amount_minor AS payment_amount,
            p.currency AS payment_currency, p.provider_payment_intent_id
     FROM new_flow_refunds r
     JOIN bookings b ON b.id = r.booking_id
     JOIN payment_attempts p
       ON p.id = r.payment_attempt_id AND p.booking_id = r.booking_id
     WHERE r.id = $1`, [refundId]
  );
  if (result.rows.length !== 1) return false;
  const r = result.rows[0];
  if (r.booking_status !== "cancelled" ||
      r.payment_flow_version !== "separate_charges_delayed_v1" ||
      r.payment_status !== "succeeded" ||
      !/^pi_[A-Za-z0-9_]+$/.test(r.provider_payment_intent_id ?? "") ||
      !Number.isSafeInteger(r.amount_minor) || r.amount_minor <= 0 ||
      !Number.isSafeInteger(r.payment_amount) || r.amount_minor > r.payment_amount ||
      !/^[A-Za-z]{3}$/.test(r.currency ?? "") ||
      String(r.currency).toUpperCase() !== String(r.payment_currency).toUpperCase()) {
    return false;
  }
  // Ambiguous legacy/new-flow ownership requires separate financial review.
  const legacyPayments = await client.query(
    "SELECT id FROM payments WHERE booking_id = $1 ORDER BY id FOR SHARE",
    [r.booking_id]
  );
  const legacyRefunds = await client.query(
    "SELECT id FROM refunds WHERE booking_id = $1 ORDER BY id FOR SHARE",
    [r.booking_id]
  );
  const legacyPayouts = await client.query(
    "SELECT id FROM payouts WHERE booking_id = $1 ORDER BY id FOR SHARE",
    [r.booking_id]
  );
  if (legacyPayments.rows.length || legacyRefunds.rows.length ||
      legacyPayouts.rows.length) return false;
  // Audit mutations lock their tuple before the trigger locks the booking.
  // Refuse busy evidence immediately to avoid the reverse lock-order cycle.
  const audits = await client.query(
    `SELECT action, object_type, previous_state, new_state
     FROM audit_log WHERE object_id = $1 ORDER BY id FOR SHARE NOWAIT`, [r.booking_id]
  );
  if (r.reason === "late_payment") {
    if (r.initiated_by !== "system" || r.amount_minor !== r.payment_amount ||
        r.hold_expires_at === null) return false;
    const expiry = new Date(r.hold_expires_at);
    if (!Number.isFinite(expiry.getTime())) return false;
    const expired = await client.query(
      "SELECT $1::timestamptz <= clock_timestamp() AS expired", [expiry]
    );
    if (expired.rows[0]?.expired !== true) return false;
    const expiryMatches = audits.rows.filter(a =>
      a.action === "booking_hold_expired" && a.object_type === "booking" &&
      a.previous_state?.status === "pending_payment" &&
      a.new_state?.status === "cancelled" &&
      a.new_state?.cancelledBy === "system" &&
      a.new_state?.reason === "payment_hold_expired" &&
      a.new_state?.holdExpiresAt === expiry.toISOString()
    );
    return expiryMatches.length === 1;
  }
  if (!["guest", "host", "admin", "system"].includes(r.initiated_by) ||
      r.reason !== r.initiated_by + "_cancellation") return false;
  const prices = await client.query(
    "SELECT * FROM booking_price_components WHERE booking_id = $1 FOR SHARE",
    [r.booking_id]
  );
  const entitlements = await client.query(
    "SELECT * FROM host_transfer_entitlements WHERE booking_id = $1 ORDER BY id FOR SHARE",
    [r.booking_id]
  );
  const counts = await client.query(
    `SELECT
       (SELECT COUNT(*)::int FROM payment_attempts WHERE booking_id = $1) AS payments,
       (SELECT COUNT(*)::int FROM new_flow_refunds WHERE booking_id = $1) AS refunds`,
    [r.booking_id]
  );
  const pc = prices.rows[0];
  const e = entitlements.rows[0];
  if (prices.rows.length !== 1 || entitlements.rows.length !== 1 ||
      counts.rows[0].payments !== 1 || counts.rows[0].refunds !== 1 ||
      pc.guest_total_minor !== r.payment_amount ||
      !Number.isSafeInteger(pc.host_payout_minor) || pc.host_payout_minor < 0 ||
      e.amount_minor !== pc.host_payout_minor || e.host_id !== r.host_id ||
      String(pc.currency).trim().toUpperCase() !== String(r.currency).toUpperCase() ||
      String(e.currency).trim().toUpperCase() !== String(r.currency).toUpperCase()) {
    return false;
  }
  const matches = audits.rows.filter(a => {
    const n = a.new_state;
    const percent = n?.refundPercent;
    return a.action === "booking_cancelled" && a.object_type === "booking" &&
      a.previous_state?.status === "confirmed" && n?.status === "cancelled" &&
      n?.cancellationKind === "paid" &&
      n?.paymentFlowVersion === "separate_charges_delayed_v1" &&
      n?.cancelledBy === r.initiated_by && n?.refundId === refundId &&
      n?.entitlementId === e.id &&
      Number.isInteger(percent) && percent > 0 && percent <= 100 &&
      n?.refundableMinor === r.amount_minor &&
      r.amount_minor === Math.round(pc.guest_total_minor * percent / 100) &&
      n?.hostRetainedMinor === Math.max(0, Math.round(e.amount_minor * (100 - percent) / 100));
  });
  return matches.length === 1;
}
