import crypto from "node:crypto";
import { db, withTransaction } from "../db";
import { hashToBigint } from "../utils/advisoryLock";
import { isCancellationHostSettlementExecutionEnabled } from "../config/featureFlags";
import { stripe } from "../payments/stripeClient";
import { cancellationSettlementEligibility } from "./cancellationSettlementEligibility";
import { sameReservation, withCancellationSettlementProviderLock } from "./withCancellationSettlementProviderLock";
import {
  findCancellationSettlementTransfer, verifyCancellationSettlementTransfer,
  type SettlementTransferExpectation,
} from "./cancellationSettlementEvidence";

function expectation(s: any): SettlementTransferExpectation {
  return {
    settlementId: s.id, bookingId: s.booking_id, entitlementId: s.entitlement_id,
    amountMinor: s.amount_minor, currency: String(s.currency).trim(),
    destination: s.stripe_connect_account_id,
  };
}

/** First execution only. Uncertain outcomes require separate reconciliation.
 * No automatic replay, API integration or cron integration.
 */
export async function executeCancellationHostSettlement(
  settlementId: string
): Promise<{ recorded: boolean; reason: string; providerTransferId?: string }> {
  if (!isCancellationHostSettlementExecutionEnabled()) {
    return { recorded: false, reason: "Cancellation settlement execution is disabled" };
  }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(settlementId)) {
    return { recorded: false, reason: "Invalid settlement identifier" };
  }
  const reference = (await db.query(
    "SELECT booking_id FROM cancellation_host_settlements WHERE id = $1", [settlementId]
  )).rows[0];
  if (!reference) return { recorded: false, reason: "Settlement not found" };
  const token = crypto.randomUUID();
  let reserved: any;
  try {
    reserved = await withTransaction(async client => {
      await client.query("SELECT pg_advisory_xact_lock($1)", [hashToBigint(reference.booking_id)]);
      await client.query("SELECT id FROM bookings WHERE id = $1 FOR UPDATE", [reference.booking_id]);
      const s = await cancellationSettlementEligibility(client, settlementId, true);
      if (s.booking_id !== reference.booking_id || s.status !== "pending" ||
          s.provider_transfer_id !== null || s.execution_token !== null ||
          s.execution_started_at !== null || s.execution_lease_expires_at !== null) return null;
      const claimed = await client.query(
        `UPDATE cancellation_host_settlements
         SET status = 'processing', execution_token = $2,
             execution_started_at = clock_timestamp(),
             execution_lease_expires_at = clock_timestamp() + interval '5 minutes',
             updated_at = NOW()
         WHERE id = $1 AND status = 'pending' AND execution_started_at IS NULL
           AND execution_token IS NULL AND provider_transfer_id IS NULL
         RETURNING id`, [settlementId, token]
      );
      return claimed.rowCount === 1 ? s : null;
    });
  } catch {
    return { recorded: false, reason: "Settlement eligibility requires review or is not yet due" };
  }
  if (!reserved) return { recorded: false, reason: "Settlement cannot be claimed" };

  async function ownership(client: any) {
    await client.query("SELECT pg_advisory_xact_lock($1)", [hashToBigint(reference.booking_id)]);
    await client.query("SELECT id FROM bookings WHERE id = $1 FOR UPDATE", [reference.booking_id]);
    const current = await cancellationSettlementEligibility(client, settlementId, true);
    const active = await client.query(
      `SELECT id FROM cancellation_host_settlements
       WHERE id = $1 AND status = 'processing' AND execution_token = $2
         AND provider_transfer_id IS NULL
         AND execution_lease_expires_at > clock_timestamp()`, [settlementId, token]
    );
    if (active.rows.length !== 1 || !sameReservation(reserved, current)) {
      throw new Error("Settlement execution ownership or reservation changed");
    }
  }
  try {
    const expected = expectation(reserved);
    const lookup = await findCancellationSettlementTransfer(expected);
    if (lookup.outcome === "unknown") throw new Error(lookup.reason);
    let providerId: string;
    if (lookup.outcome === "found") {
      providerId = lookup.transferId;
    } else {
      const transfer = await withCancellationSettlementProviderLock(reserved, token, () => {
        if (!isCancellationHostSettlementExecutionEnabled()) {
          throw new Error("Settlement execution gate was disabled");
        }
        return stripe.transfers.create({
          amount: reserved.amount_minor,
          currency: String(reserved.currency).trim().toLowerCase(),
          destination: reserved.stripe_connect_account_id,
          metadata: {
            host_cancellation_settlement_id: settlementId,
            booking_id: reserved.booking_id,
            entitlement_id: reserved.entitlement_id,
          },
        }, { idempotencyKey: reserved.idempotency_key, timeout: 20000, maxNetworkRetries: 0 });
      });
      providerId = transfer.id;
    }
    const verified = await verifyCancellationSettlementTransfer(providerId, expected);
    if (!verified.verified) throw new Error(verified.reason);
    await withTransaction(async client => {
      await ownership(client);
      const duplicate = await client.query(
        `SELECT 1 FROM host_transfer_entitlements WHERE provider_transfer_id = $1
         UNION ALL
         SELECT 1 FROM cancellation_host_settlements
         WHERE provider_transfer_id = $1 AND id <> $2`, [providerId, settlementId]
      );
      if (duplicate.rows.length) throw new Error("Transfer is already attributed to another payout");
      const completed = await client.query(
        `UPDATE cancellation_host_settlements
         SET status = 'succeeded', provider_transfer_id = $3,
             execution_token = NULL, execution_lease_expires_at = NULL,
             last_error = NULL, updated_at = NOW()
         WHERE id = $1 AND status = 'processing' AND execution_token = $2
           AND provider_transfer_id IS NULL
           AND execution_lease_expires_at > clock_timestamp()
         RETURNING id`, [settlementId, token, providerId]
      );
      if (completed.rowCount !== 1) throw new Error("Settlement completion no longer permitted");
      await client.query(
        `INSERT INTO audit_log(action, object_type, object_id, previous_state, new_state)
         VALUES ('cancellation_host_settlement_completed', 'cancellation_host_settlement',
                 $1, $2::jsonb, $3::jsonb)`,
        [settlementId, JSON.stringify({ status: "processing" }),
         JSON.stringify({ status: "succeeded", bookingId: reserved.booking_id,
           entitlementId: reserved.entitlement_id, amountMinor: reserved.amount_minor,
           currency: expected.currency, providerTransferId: providerId })]
      );
    });
    return { recorded: true, reason: "Verified retained payout recorded", providerTransferId: providerId };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown settlement outcome";
    await db.query(
      `UPDATE cancellation_host_settlements
       SET status = 'reconciliation_required', execution_lease_expires_at = NULL,
           last_error = $3, updated_at = NOW()
       WHERE id = $1 AND status = 'processing' AND execution_token = $2
         AND provider_transfer_id IS NULL`,
      [settlementId, token, message.slice(0, 2000)]
    );
    return { recorded: false, reason: "Settlement requires reconciliation" };
  }
}
