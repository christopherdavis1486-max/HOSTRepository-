import {
  inspectLegacyUnpaidIntent,
  type LegacyUnpaidIntentExpected,
} from "./legacyUnpaidIntentEvidence";

type RequestOptions = {
  timeout: number;
  maxNetworkRetries: number;
  idempotencyKey?: string;
};
export type LegacyIntentProvider = {
  retrieve(id: string, params: Record<string, never>,
    options: RequestOptions): Promise<unknown>;
  cancel(id: string, params: { cancellation_reason: "abandoned" },
    options: RequestOptions): Promise<unknown>;
};
export type LegacyIntentCancellationResult =
  | { outcome: "cancelled_unpaid" }
  | { outcome: "blocked"; reason: string }
  | { outcome: "unresolved"; reason: string };

/**
 * Caller must serialize this operation and establish booking eligibility.
 * No database writes, refunds, replacement intents or automatic retries.
 * Every invocation retrieves current evidence before any cancellation.
 */
export async function cancelLegacyUnpaidIntent(
  expected: LegacyUnpaidIntentExpected,
  provider: LegacyIntentProvider
): Promise<LegacyIntentCancellationResult> {
  const options = { timeout: 20000, maxNetworkRetries: 0 };
  let initial: unknown;
  try {
    initial = await provider.retrieve(
      expected.providerPaymentIntentId, {}, options);
  } catch {
    return { outcome: "unresolved", reason: "Initial provider lookup failed" };
  }

  const decision = inspectLegacyUnpaidIntent(expected, initial);
  if (decision.outcome !== "cancelable") return decision;

  try {
    await provider.cancel(expected.providerPaymentIntentId,
      { cancellation_reason: "abandoned" }, {
        ...options,
        idempotencyKey: "host-legacy-unpaid-cancel-" + expected.paymentId +
          "-" + expected.providerPaymentIntentId,
      });
  } catch {
    // Cancellation may have reached Stripe. Only a fresh lookup can
    // establish its outcome; never infer success or retry blindly.
  }

  try {
    const final = inspectLegacyUnpaidIntent(expected,
      await provider.retrieve(expected.providerPaymentIntentId, {}, options));
    if (final.outcome === "cancelled_unpaid") return final;
    return {
      outcome: "unresolved",
      reason: final.outcome === "blocked"
        ? final.reason : "Provider cancellation is not confirmed",
    };
  } catch {
    return { outcome: "unresolved", reason: "Cancellation outcome lookup failed" };
  }
}
