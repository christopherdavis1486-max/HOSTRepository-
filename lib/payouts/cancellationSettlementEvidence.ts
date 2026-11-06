import { stripe } from "../payments/stripeClient";

export type SettlementTransferExpectation = {
  settlementId: string;
  bookingId: string;
  entitlementId: string;
  amountMinor: number;
  currency: string;
  destination: string;
};

function validExpectation(e: SettlementTransferExpectation) {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  return [e.settlementId, e.bookingId, e.entitlementId].every(id => uuid.test(id)) &&
    Number.isSafeInteger(e.amountMinor) && e.amountMinor > 0 &&
    /^[A-Za-z]{3}$/.test(e.currency) &&
    /^acct_[A-Za-z0-9_]+$/.test(e.destination);
}

function matches(transfer: any, e: SettlementTransferExpectation) {
  const destination = typeof transfer.destination === "string"
    ? transfer.destination : transfer.destination?.id;
  return /^tr_[A-Za-z0-9_]+$/.test(transfer.id ?? "") &&
    transfer.amount === e.amountMinor &&
    transfer.currency?.toLowerCase() === e.currency.toLowerCase() &&
    destination === e.destination &&
    transfer.reversed === false && transfer.amount_reversed === 0 &&
    transfer.metadata?.host_cancellation_settlement_id === e.settlementId &&
    transfer.metadata?.booking_id === e.bookingId &&
    transfer.metadata?.entitlement_id === e.entitlementId;
}

/** Provider reads only. Absence never authorises replay of an earlier execution. */
export async function findCancellationSettlementTransfer(
  expected: SettlementTransferExpectation
): Promise<
  { outcome: "found"; transferId: string } |
  { outcome: "absent" } |
  { outcome: "unknown"; reason: string }
> {
  if (!validExpectation(expected)) {
    return { outcome: "unknown", reason: "Invalid settlement expectation" };
  }
  let cursor: string | undefined;
  let found: string | undefined;
  const cursors = new Set<string>();
  try {
    for (let pageNumber = 0; pageNumber < 100; pageNumber++) {
      const page = await stripe.transfers.list({
        destination: expected.destination,
        limit: 100,
        ...(cursor ? { starting_after: cursor } : {}),
      });
      if (!Array.isArray(page.data) || typeof page.has_more !== "boolean") {
        return { outcome: "unknown", reason: "Incomplete transfer pagination" };
      }
      for (const transfer of page.data) {
        if (transfer.metadata?.host_cancellation_settlement_id !== expected.settlementId) continue;
        if (found) return { outcome: "unknown", reason: "Duplicate settlement transfers" };
        if (!matches(transfer, expected)) {
          return { outcome: "unknown", reason: "Settlement transfer evidence mismatch" };
        }
        found = transfer.id;
      }
      if (!page.has_more) {
        return found ? { outcome: "found", transferId: found } : { outcome: "absent" };
      }
      const next = page.data[page.data.length - 1]?.id;
      if (!next || !/^tr_[A-Za-z0-9_]+$/.test(next) || cursors.has(next)) {
        return { outcome: "unknown", reason: "Incomplete or cycling transfer pagination" };
      }
      cursors.add(next);
      cursor = next;
    }
    return { outcome: "unknown", reason: "Transfer pagination limit reached" };
  } catch {
    return { outcome: "unknown", reason: "Transfer lookup unavailable" };
  }
}

/** Fresh retrieval verifies existing or newly returned provider evidence. */
export async function verifyCancellationSettlementTransfer(
  transferId: string,
  expected: SettlementTransferExpectation
): Promise<{ verified: boolean; reason: string }> {
  if (!validExpectation(expected) || !/^tr_[A-Za-z0-9_]+$/.test(transferId)) {
    return { verified: false, reason: "Invalid settlement identifiers" };
  }
  try {
    const transfer = await stripe.transfers.retrieve(transferId);
    const verified = transfer.id === transferId && matches(transfer, expected);
    return {
      verified,
      reason: verified ? "Settlement transfer verified" : "Settlement transfer evidence mismatch",
    };
  } catch {
    return { verified: false, reason: "Transfer verification unavailable" };
  }
}
