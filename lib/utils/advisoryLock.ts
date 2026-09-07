import crypto from "crypto";

/**
 * Derives a stable PostgreSQL advisory-lock key (a signed 64-bit
 * integer, as pg_advisory_xact_lock requires) from any string ID.
 * Originally defined in lib/booking/createBooking.ts for its own
 * per-property booking-creation lock; extracted here so
 * lib/payments/scheduledCharges.ts can reuse the exact same, already-
 * proven derivation for its own per-booking charge-attempt lock without
 * creating a circular import between the two files (createBooking.ts
 * already imports decideChargeTiming from scheduledCharges.ts).
 */
export function hashToBigint(input: string): string {
  const hash = crypto.createHash("sha256").update(input).digest();
  const big = hash.readBigUInt64BE(0) & 0x7fffffffffffffffn;
  return big.toString();
}
