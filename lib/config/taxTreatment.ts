/**
 * Tax ownership remains an unresolved business/legal decision (Batch 9's
 * design explicitly defers this to you). This module exists so that
 * decision, once made, has exactly one place to configure it — and so
 * that until it's made, production payment creation under the new
 * architecture fails closed rather than silently picking a default.
 */

export type TaxTreatment = "host_remits" | "platform_remits" | "unconfigured";

export class TaxTreatmentUnconfiguredError extends Error {
  constructor() {
    super("Tax treatment is unconfigured. A production PaymentIntent cannot be created under the new payment architecture until this business/legal decision is made.");
    this.name = "TaxTreatmentUnconfiguredError";
  }
}

/**
 * Resolves the tax treatment for a NEW (separate_charges_delayed_v1)
 * booking's PaymentIntent creation. Throws in production if unconfigured —
 * this is the fail-closed enforcement point, called at the moment a real
 * charge would be created, not merely at booking-row creation time (so
 * there is no window where a stale or bypassed check could let a real
 * charge through).
 *
 * Test/local fixtures may pass an explicit override — this is the ONLY
 * legitimate way to get a non-"unconfigured" value without a real
 * configured environment variable, and it is never read implicitly.
 */
export function resolveTaxTreatmentOrThrow(explicitTestOverride?: TaxTreatment): TaxTreatment {
  if (explicitTestOverride) return explicitTestOverride;

  const configured = process.env.HOST_TAX_TREATMENT;
  const value: TaxTreatment =
    configured === "host_remits" || configured === "platform_remits" ? configured : "unconfigured";

  if (value === "unconfigured" && process.env.NODE_ENV === "production") {
    throw new TaxTreatmentUnconfiguredError();
  }
  return value;
}
