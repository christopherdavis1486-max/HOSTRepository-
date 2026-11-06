import type { PoolClient } from "pg";
import { db, withTransaction } from "../db";
import { hashToBigint } from "../utils/advisoryLock";
import { isNewFlowPaymentReconciliationEnabled } from "../config/featureFlags";
import { inspectNewFlowPayment } from "./newFlowPaymentReconciliationEvidence";
import { onNewFlowPaymentSucceeded } from "./newFlowWebhookHandling";

const snapshotSql = `SELECT p.*, p.updated_at::text AS version,
       (p.lease_expires_at IS NULL OR p.lease_expires_at <= clock_timestamp()) AS lease_inactive,
       b.status AS booking_status, b.payment_flow_version, b.stripe_customer_id,
       b.host_id AS booking_host_id,
       pc.guest_total_minor, pc.currency AS price_currency,
       to_jsonb(pc) AS price_snapshot,
       (SELECT COUNT(*)::int FROM payment_attempts other
        WHERE other.booking_id = p.booking_id) AS attempt_count
 FROM payment_attempts p JOIN bookings b ON b.id = p.booking_id
 JOIN booking_price_components pc ON pc.booking_id = b.id
 WHERE p.id = $1`;

function eligible(row: any) {
  return row && row.payment_flow_version === "separate_charges_delayed_v1" &&
    ["pending_payment", "cancelled"].includes(row.booking_status) &&
    ["pending", "processing", "requires_action", "failed"].includes(row.status) &&
    row.attempt_count === 1 &&
    Number.isSafeInteger(row.amount_minor) && row.amount_minor > 0 &&
    row.amount_minor === row.guest_total_minor &&
    String(row.currency).trim().toLowerCase() ===
      String(row.price_currency).trim().toLowerCase() &&
    row.lease_inactive === true;
}

/** Provider reads only; local recording requires a fresh transactional snapshot.
 * Does not create/cancel charges, execute refunds, or cancel a booking.
 */
export async function reconcileNewFlowPayment(
  attemptId: string
): Promise<{ recorded: boolean; outcome: string; reason: string }> {
  if (!isNewFlowPaymentReconciliationEnabled()) {
    return { recorded: false, outcome: "blocked", reason: "Payment reconciliation is disabled" };
  }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(attemptId)) {
    return { recorded: false, outcome: "blocked", reason: "Invalid payment attempt identifier" };
  }
  const initial = (await db.query(snapshotSql, [attemptId])).rows[0];
  if (!eligible(initial)) {
    return { recorded: false, outcome: "blocked", reason: "Payment attempt requires separate review or has an active owner" };
  }
  const evidence = await inspectNewFlowPayment({
    bookingId: initial.booking_id, attemptId,
    customerId: initial.stripe_customer_id,
    amountMinor: initial.amount_minor, currency: String(initial.currency).trim(),
    providerPaymentIntentId: initial.provider_payment_intent_id,
  });
  if (evidence.outcome === "unresolved") {
    return { recorded: false, outcome: "unresolved", reason: evidence.reason };
  }

  async function recheck(client: PoolClient) {
    const current = (await client.query(snapshotSql + " FOR UPDATE OF p, pc", [attemptId])).rows[0];
    return isNewFlowPaymentReconciliationEnabled() && eligible(current) &&
      current.version === initial.version &&
      current.booking_id === initial.booking_id &&
      current.booking_status === initial.booking_status &&
      current.booking_host_id === initial.booking_host_id &&
      current.stripe_customer_id === initial.stripe_customer_id &&
      current.status === initial.status &&
      current.idempotency_key === initial.idempotency_key &&
      JSON.stringify(current.price_snapshot) === JSON.stringify(initial.price_snapshot) &&
      (current.lease_expires_at === null ? null : new Date(current.lease_expires_at).getTime()) ===
        (initial.lease_expires_at === null ? null : new Date(initial.lease_expires_at).getTime()) &&
      current.claim_token === initial.claim_token &&
      current.provider_payment_intent_id === initial.provider_payment_intent_id &&
      current.amount_minor === initial.amount_minor &&
      current.currency === initial.currency;
  }
  async function audit(client: PoolClient, status: string) {
    await client.query(
      `INSERT INTO audit_log(action, object_type, object_id, previous_state, new_state)
       VALUES ('payment_attempt_reconciled', 'payment_attempt', $1, $2::jsonb, $3::jsonb)`,
      [attemptId, JSON.stringify({ status: initial.status }),
       JSON.stringify({
         status, bookingId: initial.booking_id,
         providerPaymentIntentId: evidence.outcome === "unresolved" ? null : evidence.intent.id,
         reconciliationOutcome: evidence.outcome,
         amountMinor: initial.amount_minor, currency: String(initial.currency).trim(),
       })]
    );
  }

  if (evidence.outcome === "succeeded") {
    let accepted = false;
    await onNewFlowPaymentSucceeded(evidence.intent, async client => {
      if (!(await recheck(client))) return false;
      await client.query(
        "UPDATE payment_attempts SET claim_token = NULL, lease_expires_at = NULL WHERE id = $1",
        [attemptId]
      );
      await audit(client, "succeeded");
      accepted = true;
      return true;
    });
    const final = (await db.query(
      "SELECT status, provider_payment_intent_id FROM payment_attempts WHERE id = $1",
      [attemptId]
    )).rows[0];
    const recorded = accepted && final?.status === "succeeded" &&
      final.provider_payment_intent_id === evidence.intent.id;
    return {
      recorded, outcome: recorded ? "succeeded" : "blocked",
      reason: recorded ? "Verified payment success reconciled" : "Payment snapshot changed; reconciliation blocked",
    };
  }

  const recorded = await withTransaction(async client => {
    await client.query("SELECT pg_advisory_xact_lock($1)", [hashToBigint(initial.booking_id)]);
    await client.query("SELECT id FROM bookings WHERE id = $1 FOR UPDATE", [initial.booking_id]);
    if (!(await recheck(client))) return false;
    const updated = await client.query(
      `UPDATE payment_attempts
       SET status = 'cancelled', provider_payment_intent_id = $2,
           claim_token = NULL, lease_expires_at = NULL,
           failure_code = NULL, failure_message = NULL, updated_at = NOW()
       WHERE id = $1 RETURNING id`,
      [attemptId, evidence.intent.id]
    );
    if (updated.rowCount !== 1) throw new Error("Cancelled payment recording failed");
    await audit(client, "cancelled");
    return true;
  });
  return {
    recorded, outcome: recorded ? "cancelled_unpaid" : "blocked",
    reason: recorded ? "Verified terminal nonpayment recorded" : "Payment snapshot changed; reconciliation blocked",
  };
}
