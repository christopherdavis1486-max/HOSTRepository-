import { db } from "../db";
import { stripe } from "../payments/stripeClient";

/**
 * Per the accepted design's correction: legacy reconciliation is NOT
 * "entirely read-only" if it persists anything, so it is split into two
 * genuinely separate functions. Only the report-only discovery function
 * is implemented in this batch — persistence requires a separate,
 * explicit approval step and is deliberately not built here.
 *
 * Under destination charges, Stripe already created a real transfer for
 * every successful charge — this function's job is to DISCOVER what that
 * transfer ID was (a pure, read-only Stripe lookup), never to create,
 * modify, or move anything. A legacy row's null provider_transfer_id
 * means HOST never recorded it, not that no transfer occurred — this
 * function exists specifically to correct that gap in HOST's own
 * records, honestly, one row at a time.
 *
 * Stripe test-mode and live-mode data must never be mixed — every
 * discovered record includes the real `livemode` flag Stripe itself
 * reports on the PaymentIntent, so a report consumer can immediately see
 * which environment each result came from and never conflate them.
 */

export type ReconciliationResult =
  | { bookingId: string; outcome: "transfer_found"; providerTransferId: string; livemode: boolean; stripeAccountId: string | null }
  | { bookingId: string; outcome: "legacy_reconciliation_required"; reason: string; livemode: boolean | null };

/**
 * Report-only: looks up each legacy booking's PaymentIntent, expands
 * latest_charge.transfer, and returns what it found. Makes NO database
 * write anywhere in this function. The caller decides what to do with
 * the report — persisting any of it is a deliberately separate function
 * this batch does not implement.
 */
export async function discoverLegacyTransfers(bookingIds: string[]): Promise<ReconciliationResult[]> {
  const results: ReconciliationResult[] = [];

  for (const bookingId of bookingIds) {
    const paymentRow = await db.query(
      `SELECT provider_payment_intent_id FROM payments WHERE booking_id = $1`,
      [bookingId]
    );
    if (paymentRow.rows.length === 0 || !paymentRow.rows[0].provider_payment_intent_id) {
      results.push({ bookingId, outcome: "legacy_reconciliation_required", reason: "no payment_intent_id recorded for this booking", livemode: null });
      continue;
    }

    try {
      const paymentIntent = await stripe.paymentIntents.retrieve(paymentRow.rows[0].provider_payment_intent_id, {
        expand: ["latest_charge"],
      });
      const charge = paymentIntent.latest_charge;
      if (!charge || typeof charge === "string" || !charge.transfer) {
        results.push({ bookingId, outcome: "legacy_reconciliation_required", reason: "no transfer found on the PaymentIntent's latest charge", livemode: paymentIntent.livemode });
        continue;
      }
      const transferId = typeof charge.transfer === "string" ? charge.transfer : charge.transfer.id;
      const destination = typeof charge.transfer === "string" ? null : (typeof charge.transfer.destination === "string" ? charge.transfer.destination : charge.transfer.destination?.id ?? null);
      results.push({ bookingId, outcome: "transfer_found", providerTransferId: transferId, livemode: paymentIntent.livemode, stripeAccountId: destination });
    } catch (error) {
      results.push({ bookingId, outcome: "legacy_reconciliation_required", reason: `Stripe lookup failed: ${(error as Error).message}`, livemode: null });
    }
  }

  return results;
}

/** All bookings genuinely eligible for reconciliation reporting — every
 *  destination_charge_legacy booking that has a payment. Read-only. */
export async function listLegacyBookingIdsForReconciliation(): Promise<string[]> {
  const result = await db.query(
    `SELECT b.id FROM bookings b
     JOIN payments p ON p.booking_id = b.id
     WHERE b.payment_flow_version = 'destination_charge_legacy' AND p.status = 'paid'
     ORDER BY b.created_at ASC`
  );
  return result.rows.map((r) => r.id);
}
