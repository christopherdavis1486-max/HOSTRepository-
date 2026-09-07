import { db } from "../db";
import { stripe } from "../payments/stripeClient";

/**
 * Run on a schedule (e.g. hourly via a cron trigger — Vercel Cron, a
 * queue worker, whatever HOST's infrastructure already uses; nothing here
 * is Vercel-specific). Finds payouts whose scheduled_release_at has
 * passed with no open dispute on the booking, and releases them.
 *
 * With destination charges (the pattern createPaymentIntent.ts uses),
 * funds typically land with the host's connected account automatically at
 * charge time via transfer_data — in which case this job's real job is
 * bookkeeping (marking the payouts row 'paid') rather than moving money
 * itself. If HOST switches to separate-charges-and-transfers (§4.4 of the
 * technical spec) so payout timing is fully under HOST's control instead
 * of Stripe's default timing, this is where the actual stripe.transfers.create
 * call would go — left as a clearly marked TODO rather than guessed at,
 * since that's a real architecture decision, not a default to assume.
 */
export async function releaseDuePayouts() {
  const due = await db.query(
    `SELECT p.id, p.host_id, p.booking_id, p.amount_minor, p.currency, hp.stripe_connect_account_id
     FROM payouts p
     JOIN host_profiles hp ON hp.id = p.host_id
     WHERE p.status = 'scheduled'
       AND p.scheduled_release_at <= NOW()
       AND NOT EXISTS (SELECT 1 FROM disputes d WHERE d.booking_id = p.booking_id AND d.status NOT IN ('won', 'lost', 'closed'))
     LIMIT 100`
  );

  const results = [];
  for (const row of due.rows) {
    try {
      // TODO: if using separate charges + transfers, create the actual
      // transfer here:
      //   await stripe.transfers.create({ amount: row.amount_minor, currency: row.currency, destination: row.stripe_connect_account_id, transfer_group: row.booking_id });
      // With destination charges, the transfer already happened at charge
      // time — this just confirms and records it.
      await db.query(`UPDATE payouts SET status = 'paid', released_at = NOW(), updated_at = NOW() WHERE id = $1`, [row.id]);
      await db.query(
        `UPDATE ledger_entries SET status = 'paid' WHERE booking_id = $1 AND type = 'host_payout' AND status = 'pending'`,
        [row.booking_id]
      );
      results.push({ payoutId: row.id, status: "paid" });
    } catch (err) {
      await db.query(`UPDATE payouts SET status = 'failed', updated_at = NOW() WHERE id = $1`, [row.id]);
      results.push({ payoutId: row.id, status: "failed", error: (err as Error).message });
    }
  }
  return results;
}
