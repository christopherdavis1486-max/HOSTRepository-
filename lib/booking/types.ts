export type PropertyForPricing = {
  id: string;
  nightlyPriceMinor: number; // stored as major-unit numeric in Postgres; converted to minor units at the boundary — see priceEngine.ts
  cleaningFeeMinor: number;
  currency: string;
};

export type FeeConfig = {
  version: string;
  guestServiceFeeRate: number;
  hostCommissionRate: number;
  taxRate: number;
};

export type PriceBreakdown = {
  currency: string;
  nights: number;
  accommodationMinor: number;
  cleaningMinor: number;
  guestServiceFeeMinor: number;
  taxesMinor: number;
  guestTotalMinor: number;
  hostCommissionMinor: number;
  hostPayoutMinor: number;
  hostRevenueMinor: number;
  feeConfigVersion: string;
};

export type CancellationTier = { cutoffHours: number; refundPercent: number };
export type CancellationPolicy = { id: string; name: string; rules: CancellationTier[] };

export type BookingStatus =
  | "draft" | "pending_payment" | "confirmed" | "cancelled" | "completed" | "refunded" | "disputed";

export type PaymentStatus =
  | "pending" | "processing" | "paid" | "failed" | "refunded" | "partially_refunded" | "disputed";

export class BookingError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}
