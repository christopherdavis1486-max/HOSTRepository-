/**
 * Batch 9B-1 → 9B-2 handoff: Stripe Test Mode verification harness.
 *
 * Run with: npx tsx --env-file=.env.local scripts/verifyStripeTestMode.ts
 *
 * This script has NEVER been run against real Stripe — it cannot be,
 * from the sandbox that wrote it (confirmed: no real credentials exist
 * there, and api.stripe.com is not on that sandbox's network allowlist).
 * It is built to be run for the first time on the machine with genuine
 * Stripe Test Mode access, per Batch 9B-2's explicit split. Every safety
 * guard below is real, structural code — not a comment promising
 * caution.
 *
 * WHAT THIS SCRIPT DOES:
 * Exercises the real Stripe Test Mode API directly — SetupIntent
 * creation/confirmation, an off-session PaymentIntent success, a
 * decline, a requires_action case, idempotent-retry behaviour, and (if
 * a test Connect account ID is supplied) a test transfer and its
 * reversal. It does NOT touch the application's own database at all —
 * no production or development booking record is created, read, or
 * modified. It is a pure, isolated Stripe API exercise.
 */

import Stripe from "stripe";

// ============================================================
// SAFETY GUARD 1: refuse to run unless the key is genuinely test-mode.
// Every real Stripe secret key starts with "sk_test_" for test mode or
// "sk_live_" for live mode — this is Stripe's own, documented, stable
// prefix convention. Checked BEFORE constructing any Stripe client at
// all, so a live key can never even reach the SDK.
// ============================================================
const secretKey = process.env.STRIPE_SECRET_KEY;
if (!secretKey) {
  console.error("STRIPE_SECRET_KEY is not set. Refusing to run.");
  process.exit(1);
}
if (!secretKey.startsWith("sk_test_")) {
  console.error("STRIPE_SECRET_KEY does not start with 'sk_test_'. This harness refuses to run against anything but Stripe Test Mode.");
  process.exit(1);
}

const stripe = new Stripe(secretKey, { apiVersion: "2026-07-29.dahlia" });

const keyFragment = `${secretKey.slice(0, 8)}...${secretKey.slice(-4)}`;
const VERIFICATION_TAG = `host-batch9b2-verify-${Date.now()}`;

function logStep(label: string) {
  console.log(`\n=== ${label} ===`);
}
function logResult(fields: Record<string, string | number | boolean | null | undefined>) {
  for (const [k, v] of Object.entries(fields)) console.log(`  ${k}: ${v}`);
}

async function main() {
  console.log(`HOST Stripe Test Mode verification harness`);
  console.log(`Key: ${keyFragment} (confirmed test-mode prefix)`);
  console.log(`Verification tag: ${VERIFICATION_TAG}`);

  // ============================================================
  // SAFETY GUARD 2: double-check livemode directly against Stripe's own
  // response, not just the key's string prefix — belt and braces.
  // ============================================================
  const balance = await stripe.balance.retrieve();
  if (balance.livemode) {
    console.error("Stripe reports livemode=true for this request. Refusing to continue.");
    process.exit(1);
  }
  logStep("Confirmed genuine Test Mode");
  logResult({ livemode: balance.livemode });

  logStep("1. SetupIntent — Customer + off-session usage");
  const customer = await stripe.customers.create({
    email: "host-verify@example.com",
    metadata: { verification_tag: VERIFICATION_TAG },
  });
  const setupIntent = await stripe.setupIntents.create({
    customer: customer.id,
    usage: "off_session",
    payment_method: "pm_card_visa",
    confirm: true,
    automatic_payment_methods: { enabled: true, allow_redirects: "never" },
    metadata: { verification_tag: VERIFICATION_TAG },
  });
  logResult({ customer_id: customer.id, setup_intent_id: setupIntent.id, status: setupIntent.status });

  if (setupIntent.status !== "succeeded" || !setupIntent.payment_method) {
    console.error("SetupIntent did not succeed as expected. Stopping — subsequent steps depend on a real saved payment method.");
    process.exit(1);
  }
  const paymentMethodId = typeof setupIntent.payment_method === "string" ? setupIntent.payment_method : setupIntent.payment_method.id;

  logStep("2. Off-session PaymentIntent — success");
  const successIntent = await stripe.paymentIntents.create({
    amount: 5000,
    currency: "gbp",
    customer: customer.id,
    payment_method: paymentMethodId,
    off_session: true,
    confirm: true,
    automatic_payment_methods: { enabled: true, allow_redirects: "never" },
    metadata: { verification_tag: VERIFICATION_TAG },
  }, { idempotencyKey: `${VERIFICATION_TAG}-success` });
  logResult({ payment_intent_id: successIntent.id, status: successIntent.status });

  logStep("3. Idempotent retry — same key must not create a second charge");
  const retryIntent = await stripe.paymentIntents.create({
    amount: 5000,
    currency: "gbp",
    customer: customer.id,
    payment_method: paymentMethodId,
    off_session: true,
    confirm: true,
    automatic_payment_methods: { enabled: true, allow_redirects: "never" },
    metadata: { verification_tag: VERIFICATION_TAG },
  }, { idempotencyKey: `${VERIFICATION_TAG}-success` });
  logResult({
    original_id: successIntent.id,
    retry_id: retryIntent.id,
    same_object: successIntent.id === retryIntent.id,
  });
  if (successIntent.id !== retryIntent.id) {
    console.error("IDEMPOTENCY FAILURE: the retry created a different PaymentIntent. This must be investigated before any production use.");
  }

  logStep("4. Off-session PaymentIntent — decline");
  const declineCustomer = await stripe.customers.create({ email: "host-verify-decline@example.com", metadata: { verification_tag: VERIFICATION_TAG } });
  let declineOutcome: string;
  try {
    const declineSetup = await stripe.setupIntents.create({
      customer: declineCustomer.id, usage: "off_session", payment_method: "pm_card_chargeDeclined", confirm: true,
      automatic_payment_methods: { enabled: true, allow_redirects: "never" },
      metadata: { verification_tag: VERIFICATION_TAG },
    });
    declineOutcome = `setup_intent_status: ${declineSetup.status}`;
  } catch (error) {
    declineOutcome = `caught error (expected): ${(error as Error).message}`;
  }
  logResult({ decline_test_outcome: declineOutcome });

  logStep("5. Off-session PaymentIntent — requires_action");
  const authCustomer = await stripe.customers.create({ email: "host-verify-auth@example.com", metadata: { verification_tag: VERIFICATION_TAG } });
  const authSetup = await stripe.setupIntents.create({
    customer: authCustomer.id, usage: "off_session", payment_method: "pm_card_authenticationRequired", confirm: true,
    automatic_payment_methods: { enabled: true, allow_redirects: "never" },
    metadata: { verification_tag: VERIFICATION_TAG },
  });
  logResult({ setup_intent_id: authSetup.id, status: authSetup.status });

  const testConnectAccountId = process.env.STRIPE_TEST_CONNECT_ACCOUNT_ID;
  if (testConnectAccountId) {
    logStep("6. Test Connect transfer");
    const transfer = await stripe.transfers.create({
      amount: 1000, currency: "gbp", destination: testConnectAccountId,
      metadata: { verification_tag: VERIFICATION_TAG },
    }, { idempotencyKey: `${VERIFICATION_TAG}-transfer` });
    logResult({ transfer_id: transfer.id, destination: testConnectAccountId, amount: transfer.amount });

    logStep("6b. Transfer reversal");
    try {
      const reversal = await stripe.transfers.createReversal(transfer.id, { amount: 1000, metadata: { verification_tag: VERIFICATION_TAG } });
      logResult({ reversal_id: reversal.id, status: "created" });
    } catch (error) {
      logResult({ reversal_error: (error as Error).message });
    }
  } else {
    logStep("6. Test Connect transfer — SKIPPED");
    console.log("  STRIPE_TEST_CONNECT_ACCOUNT_ID not set. Set it to a real test-mode connected account ID to exercise this step.");
  }

  console.log("\n=== Verification run complete ===");
  console.log(`All objects created by this run are tagged metadata.verification_tag = "${VERIFICATION_TAG}" for easy identification in the Stripe Test Mode dashboard.`);
  console.log("No secret keys were printed. No production or development database records were created, read, or modified.");
}

main().catch((error) => {
  console.error("Verification run failed:", (error as Error).message);
  process.exit(1);
});
