import Stripe from "stripe";

let stripeInstance: Stripe | null = null;

/**
 * Deliberately lazy — `new Stripe(undefined)` throws synchronously at
 * construction time (same failure mode already found and fixed for
 * Resend in lib/notifications/emailProvider.ts). The previous version of
 * this file constructed the client at module top level, which meant
 * merely *importing* stripeClient.ts — something every payment-related
 * route does — crashed `next build`'s page-data-collection step whenever
 * STRIPE_SECRET_KEY wasn't present in the build environment. Confirmed
 * via an actual `next build` run, not by inspection.
 */
function getStripeClient(): Stripe {
  if (!stripeInstance) {
    // This literal must match what the installed `stripe` package's types
    // expect — it changes when the SDK is upgraded. If `tsc` complains
    // about this line after an `npm update`, that's the fix: use whatever
    // version string the type error says it wants.
    stripeInstance = new Stripe(process.env.STRIPE_SECRET_KEY as string, {
      apiVersion: "2026-07-29.dahlia",
    });
  }
  return stripeInstance;
}

// A Proxy preserves every existing call site exactly as it was written
// (`stripe.paymentIntents.create(...)`, `stripe.webhooks.constructEvent(...)`,
// etc., across every file that already imports `{ stripe }`) while
// deferring actual SDK construction — and therefore the API-key
// validation that throws — until the first real property access, which
// only happens when a request handler actually runs, not at build or
// import time.
export const stripe = new Proxy({} as Stripe, {
  get(_target, prop, receiver) {
    return Reflect.get(getStripeClient(), prop, receiver);
  },
});
