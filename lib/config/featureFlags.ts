/**
 * Batch 9's financial activation gates. All three default OFF and must be
 * explicitly, individually enabled via environment variable — never
 * implicitly, never as a group. This is the single source of truth every
 * new-architecture code path checks; no other module should read these
 * env vars directly.
 *
 * Fail-closed: any value other than the exact string "true" is treated as
 * off, including unset, empty, "1", "yes", etc. — deliberately strict, so a
 * typo or partial configuration can never accidentally enable live
 * financial behaviour.
 */

function isEnabled(envVarName: string): boolean {
  return process.env[envVarName] === "true";
}

/** Gate 1: may a NEW booking be created under the new
 *  separate_charges_delayed_v1 architecture at all? If off, every new
 *  booking continues to use destination_charge_legacy exactly as before —
 *  createBooking.ts's existing behaviour is completely unchanged. */
export function isDelayedChargeBookingCreationEnabled(): boolean {
  return isEnabled("ENABLE_DELAYED_CHARGE_BOOKINGS");
}

/** Gate 2: may the scheduled sweep actually attempt a real off-session
 *  PaymentIntent for a due, separate_charges_delayed_v1 booking? Distinct
 *  from Gate 1 — a booking could theoretically exist under the new
 *  architecture (Gate 1 on) while automated charging remains off, though
 *  in practice Gate 1 defaulting off means no such booking can exist yet
 *  either. */
export function isAutomatedOffSessionChargingEnabled(): boolean {
  return isEnabled("ENABLE_AUTOMATED_OFFSESSION_CHARGING");
}

/** Gate 3: may the transfer-release worker ever call
 *  stripe.transfers.create() for real? This is checked independently of
 *  Gates 1 and 2, and MUST remain off even if both of those are on —
 *  entitlement rows can exist (created after a real successful payment)
 *  without ever being allowed to actually transfer. */
export function isHostTransferExecutionEnabled(): boolean {
  return isEnabled("ENABLE_HOST_TRANSFER_EXECUTION");
}
