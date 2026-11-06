/** Display only; a transfer to a connected account is not a bank payout. */
export function newFlowPayoutLabel(input: {
  entitlementStatus: string | null;
  settlementStatus: string | null;
  settlementCount: number;
}): string {
  if (input.settlementCount > 1) return "Payout needs review";
  if (input.entitlementStatus === "cancellation_settlement_required") {
    if (input.settlementCount !== 1) return "Retained payout needs review";
    switch (input.settlementStatus) {
      case "pending": return "Retained payout pending";
      case "processing": return "Retained payout in progress";
      case "succeeded": return "Retained payout transferred";
      default: return "Retained payout needs review";
    }
  }
  if (input.settlementCount !== 0) return "Payout needs review";
  switch (input.entitlementStatus) {
    case "transfer_created": return "Transfer sent to connected account";
    case "transfer_claimed": return "Payout queued";
    case "transfer_processing": return "Transfer in progress";
    case "transfer_reconciliation_required": return "Payout needs review";
    case "transfer_failed": return "Transfer failed";
    case "cancelled_before_transfer": return "Transfer cancelled";
    case "entitled":
    case "release_due": return "Payout pending";
    default: return "Payout status needs review";
  }
}
