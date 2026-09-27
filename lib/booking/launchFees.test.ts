import assert from "node:assert/strict";
import test from "node:test";
import { calculatePrice } from "./priceEngine";

const launch = { version: "host-15-inclusive-v1", guestServiceFeeRate: 0, hostCommissionRate: 0.15, taxRate: 0 };

test("VAT belongs to the property and commission excludes VAT and cleaning", () => {
  const price = calculatePrice({ id: "test", nightlyPriceMinor: 30000, cleaningFeeMinor: 2000,
    currency: "GBP", accommodationVatRate: 0.2, cleaningVatRate: 0.2 }, 1, launch);
  assert.deepEqual({ guestTotal: price.guestTotalMinor, vat: price.taxesMinor,
    commission: price.hostCommissionMinor, payout: price.hostPayoutMinor,
    guestFee: price.guestServiceFeeMinor },
  { guestTotal: 38400, vat: 6400, commission: 4500, payout: 33900, guestFee: 0 });
  assert.equal(price.guestTotalMinor, price.hostPayoutMinor + price.hostRevenueMinor);
});

test("unreviewed property cannot be quoted under launch configuration", () => {
  assert.throws(() => calculatePrice({ id: "test", nightlyPriceMinor: 30000,
    cleaningFeeMinor: 0, currency: "GBP" }, 1, launch), /VAT treatment is unconfigured/);
});

test("historic v1 fee snapshots keep their original calculation", () => {
  const price = calculatePrice({ id: "test", nightlyPriceMinor: 10000, cleaningFeeMinor: 2000,
    currency: "GBP" }, 2, { version: "v1", guestServiceFeeRate: 0.12,
    hostCommissionRate: 0.03, taxRate: 0.05 });
  assert.equal(price.guestTotalMinor, 25500);
  assert.equal(price.hostPayoutMinor, 21400);
});
