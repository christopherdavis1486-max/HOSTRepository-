import { PropertyForPricing, FeeConfig, PriceBreakdown } from "./types";

export function nightsBetween(checkIn: string, checkOut: string): number {
  const ms = new Date(checkOut).getTime() - new Date(checkIn).getTime();
  return Math.round(ms / 86400000);
}

/**
 * Every component stored individually and never recomputed retroactively
 * once a booking exists (technical spec §24). This is the same calculation
 * already exercised in the client prototype's `calculatePrice` — same
 * shape, same rounding behaviour, adapted here to operate on integer minor
 * units throughout rather than floats, since this version's output gets
 * persisted to a database and handed to Stripe (which requires minor
 * units), not just rendered in a UI.
 */
export function calculatePrice(
  property: PropertyForPricing,
  nights: number,
  feeConfig: FeeConfig
): PriceBreakdown {
  if (nights <= 0) throw new Error("nights must be positive");

  const accommodationMinor = property.nightlyPriceMinor * nights;
  const cleaningMinor = property.cleaningFeeMinor;
  const guestServiceFeeMinor = Math.round(accommodationMinor * feeConfig.guestServiceFeeRate);
  // Launch pricing is explicitly VAT-exclusive. Historic v1 bookings keep
  // their original formula; new bookings must have property-specific rates.
  if (feeConfig.version === "host-15-inclusive-v1" &&
      (property.accommodationVatRate == null || property.cleaningVatRate == null)) {
    throw new Error("Property VAT treatment is unconfigured");
  }
  const taxesMinor = feeConfig.version === "host-15-inclusive-v1"
    ? Math.round(accommodationMinor * property.accommodationVatRate!) +
      Math.round(cleaningMinor * property.cleaningVatRate!)
    : Math.round((accommodationMinor + cleaningMinor) * feeConfig.taxRate);
  const guestTotalMinor = accommodationMinor + cleaningMinor + guestServiceFeeMinor + taxesMinor;

  const hostCommissionMinor = Math.round(accommodationMinor * feeConfig.hostCommissionRate);
  // The property accounts for VAT on its accommodation and cleaning supply.
  // Never leave the VAT amount in HOST's platform balance when paying the host.
  const hostPayoutMinor = accommodationMinor + cleaningMinor +
    (feeConfig.version === "host-15-inclusive-v1" ? taxesMinor : 0) - hostCommissionMinor;
  const hostRevenueMinor = hostCommissionMinor + guestServiceFeeMinor;

  return {
    currency: property.currency,
    nights,
    accommodationMinor,
    cleaningMinor,
    guestServiceFeeMinor,
    taxesMinor,
    guestTotalMinor,
    hostCommissionMinor,
    hostPayoutMinor,
    hostRevenueMinor,
    feeConfigVersion: feeConfig.version,
  };
}

export async function getActiveFeeConfig(client: { query: Function }): Promise<FeeConfig> {
  const result = await client.query(
    `SELECT version, guest_service_fee_rate, host_commission_rate, tax_rate
     FROM fee_configs WHERE active = TRUE ORDER BY effective_from DESC LIMIT 1`
  );
  if (result.rows.length === 0) {
    throw new Error("No active fee_configs row — seed one before creating bookings (see scripts/seedFeeConfig.ts)");
  }
  const row = result.rows[0];
  return {
    version: row.version,
    guestServiceFeeRate: Number(row.guest_service_fee_rate),
    hostCommissionRate: Number(row.host_commission_rate),
    taxRate: Number(row.tax_rate),
  };
}
