import type { PoolClient } from "pg";
import { calculateCancellation } from "./cancellationEngine";
import { BookingError } from "./types";

/** Reads eligibility only. Cancellation enables row locks and rechecks before writing. */
export async function paidNewFlowCancellationEligibility(
  client: Pick<PoolClient, "query">, b: Record<string, any>, lock = false
) {
    const refuse = (message: string): never => {
      throw new BookingError("NOT_CANCELLABLE", message);
    };
    if (b.payment_flow_version !== "separate_charges_delayed_v1" || b.status !== "confirmed") {
      refuse("Paid cancellation requires a confirmed new-flow booking");
    }

    const attempts = await client.query(
      "SELECT * FROM payment_attempts WHERE booking_id = $1 ORDER BY attempt_number" + (lock ? " FOR UPDATE" : ""),
      [b.id]
    );
    const paid = attempts.rows.filter(row => row.status === "succeeded");
    if (paid.length !== 1 || attempts.rows.some(row => row.status !== "succeeded")) {
      refuse("Payment attempts require reconciliation before paid cancellation");
    }
    const payment = paid[0];
    if (typeof payment.provider_payment_intent_id !== "string" ||
        !/^pi_[A-Za-z0-9_]+$/.test(payment.provider_payment_intent_id)) {
      refuse("Successful payment has no valid provider reference");
    }
    const prices = await client.query(
      "SELECT * FROM booking_price_components WHERE booking_id = $1", [b.id]
    );
    const pc = prices.rows[0];
    if (!pc ||
        !Number.isSafeInteger(pc.guest_total_minor) || pc.guest_total_minor <= 0 ||
        !Number.isSafeInteger(pc.host_payout_minor) || pc.host_payout_minor < 0 ||
        payment.amount_minor !== pc.guest_total_minor ||
        String(payment.currency).trim().toUpperCase() !== String(pc.currency).trim().toUpperCase()) {
      refuse("Payment and booking prices require reconciliation");
    }
    const existingRefunds = await client.query(
      "SELECT id FROM new_flow_refunds WHERE booking_id = $1", [b.id]
    );
    const legacyRefunds = await client.query(
      "SELECT id FROM refunds WHERE booking_id = $1", [b.id]
    );
    if (existingRefunds.rows.length || legacyRefunds.rows.length) {
      refuse("Existing refund requires reconciliation before cancellation");
    }

    const entitlements = await client.query(
      "SELECT * FROM host_transfer_entitlements WHERE booking_id = $1" + (lock ? " FOR UPDATE" : ""),
      [b.id]
    );
    const e = entitlements.rows[0];
    if (entitlements.rows.length !== 1 || e.host_id !== b.host_id ||
        e.amount_minor !== pc.host_payout_minor ||
        String(e.currency).trim().toUpperCase() !== String(pc.currency).trim().toUpperCase()) {
      refuse("Host entitlement requires reconciliation before cancellation");
    }
    const transferred = e.status === "transfer_created";
    const notStarted = ["entitled", "release_due", "transfer_claimed"].includes(e.status);
    if ((!transferred && !notStarted) ||
        (notStarted && e.provider_transfer_id !== null) ||
        (transferred && (typeof e.provider_transfer_id !== "string" ||
          !/^tr_[A-Za-z0-9_]+$/.test(e.provider_transfer_id)))) {
      refuse("Host transfer outcome requires reconciliation before cancellation");
    }
    const reversals = await client.query(
      "SELECT id FROM host_transfer_reversals WHERE entitlement_id = $1" + (lock ? " FOR UPDATE" : ""), [e.id]
    );
    if (reversals.rows.length) refuse("Existing reversal requires reconciliation");

    const outcome = calculateCancellation(
      { id: "snapshot", name: "snapshot", rules: b.cancellation_policy_snapshot },
      b.check_in, pc.guest_total_minor, pc.host_payout_minor
    );
    if (!Number.isSafeInteger(outcome.refundableMinor) ||
        outcome.refundableMinor < 0 || outcome.refundableMinor > payment.amount_minor ||
        !Number.isSafeInteger(outcome.hostRetainedMinor) ||
        outcome.hostRetainedMinor < 0 || outcome.hostRetainedMinor > e.amount_minor) {
      refuse("Invalid cancellation policy outcome");
    }


  return { payment, pc, e, transferred, notStarted, outcome };
}
