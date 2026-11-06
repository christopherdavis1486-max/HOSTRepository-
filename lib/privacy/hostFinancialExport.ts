import { db } from "../db";
import { newFlowPayoutLabel } from "../presentation/newFlowPayout";

/** Own host financial records only; no guest contact data or provider execution secrets.
 * Local records do not establish provider verification or bank payout completion.
 */
export async function listHostFinancialExport(userId: string) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(userId)) {
    throw new Error("Invalid export user identifier");
  }
  const result = await db.query(
    `SELECT b.id AS booking_id, b.property_id, b.check_in, b.check_out,
       b.status AS booking_status, b.payment_flow_version,
       pc.currency, pc.host_commission_minor, pc.host_payout_minor,
       COALESCE((
         SELECT jsonb_agg(jsonb_build_object(
           'status', e.status, 'amount_minor', e.amount_minor,
           'currency', e.currency, 'scheduled_release_at', e.scheduled_release_at
         ) ORDER BY e.id)
         FROM host_transfer_entitlements e
         WHERE e.booking_id = b.id AND e.host_id = hp.id
           AND b.payment_flow_version = 'separate_charges_delayed_v1'
       ), '[]'::jsonb) AS transfers,
       COALESCE((
         SELECT jsonb_agg(jsonb_build_object(
           'status', s.status, 'amount_minor', s.amount_minor,
           'currency', s.currency, 'scheduled_release_at', s.scheduled_release_at
         ) ORDER BY s.id)
         FROM cancellation_host_settlements s
         JOIN host_transfer_entitlements e
           ON e.id = s.entitlement_id AND e.booking_id = s.booking_id AND e.host_id = s.host_id
         WHERE s.booking_id = b.id AND s.host_id = hp.id
           AND b.payment_flow_version = 'separate_charges_delayed_v1'
       ), '[]'::jsonb) AS retained_settlements,
       COALESCE((
         SELECT jsonb_agg(jsonb_build_object(
           'status', r.status, 'amount_minor', r.amount_minor, 'currency', e.currency,
           'reason', r.reason
         ) ORDER BY r.id)
         FROM host_transfer_reversals r
         JOIN host_transfer_entitlements e ON e.id = r.entitlement_id
         WHERE e.booking_id = b.id AND e.host_id = hp.id
           AND b.payment_flow_version = 'separate_charges_delayed_v1'
       ), '[]'::jsonb) AS transfer_reversals,
       COALESCE((
         SELECT jsonb_agg(jsonb_build_object(
           'status', p.status, 'amount_minor', p.amount_minor,
           'currency', p.currency, 'scheduled_release_at', p.scheduled_release_at
         ) ORDER BY p.id)
         FROM payouts p WHERE p.booking_id = b.id AND p.host_id = hp.id
           AND b.payment_flow_version = 'destination_charge_legacy'
       ), '[]'::jsonb) AS legacy_payouts
     FROM host_profiles hp JOIN bookings b ON b.host_id = hp.id
     LEFT JOIN booking_price_components pc ON pc.booking_id = b.id
     WHERE hp.user_id = $1
     ORDER BY b.created_at DESC, b.id DESC`, [userId]
  );
  return result.rows.map(row => ({
    ...row,
    payout_display_label: row.payment_flow_version === "separate_charges_delayed_v1"
      ? row.transfers.length > 1 ? "Payout needs review" : newFlowPayoutLabel({
          entitlementStatus: row.transfers[0]?.status ?? null,
          settlementStatus: row.retained_settlements[0]?.status ?? null,
          settlementCount: row.retained_settlements.length,
        })
      : null,
  }));
}
