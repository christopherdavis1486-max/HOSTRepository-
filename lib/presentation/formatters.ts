/**
 * Pure presentation formatters, shared across the three guest-facing
 * booking surfaces (booking confirmation, My Trips, Trip Detail) for
 * consistency. Display-only — none of these touch stored dates, status
 * values, or amounts; they only change how existing backend-authoritative
 * values are rendered.
 */

/**
 * "2026-10-25T00:00:00.000Z" → "25 Oct 2026" (UK-friendly).
 *
 * Deliberately does NOT use `new Date(iso).toLocaleDateString()` directly
 * on the full ISO string — parsing an ISO string with a time component
 * as a JS Date interprets it in UTC, and formatting that Date in a
 * browser running in a non-UTC timezone (e.g. any UK evening during
 * BST, UTC+1) can roll the displayed calendar day backward or forward
 * by one. Booking dates are calendar dates (check-in/check-out), not
 * instants — a guest checking in "25 Oct 2026" must never see "24 Oct
 * 2026" just because their browser is in a different timezone offset.
 * This extracts the Y/M/D digits directly from the ISO string's date
 * portion (or accepts a plain "YYYY-MM-DD" string, same handling) and
 * formats those literal digits, with zero timezone conversion involved
 * at any point.
 */
export function formatDate(isoOrDateString: string): string {
  const datePart = isoOrDateString.slice(0, 10); // "YYYY-MM-DD", whether the input had a time component or not
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(datePart);
  if (!match) return isoOrDateString; // unrecognized shape — show the raw value rather than crash or silently lie
  const [, year, month, day] = match;
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const monthIndex = Number(month) - 1;
  if (monthIndex < 0 || monthIndex > 11) return isoOrDateString;
  return `${Number(day)} ${MONTHS[monthIndex]} ${year}`;
}

/**
 * Booking/payment status → user-facing label. An explicit map, not
 * scattered string replacement — one place to see every known value.
 * Anything not in the map degrades gracefully (capitalized, underscores
 * replaced with spaces) rather than crashing or showing nothing, so a
 * future backend status this map doesn't yet know about still renders
 * something reasonable instead of breaking the page.
 */
const STATUS_LABELS: Record<string, string> = {
  pending_payment: "Pending payment",
  confirmed: "Confirmed",
  cancelled: "Cancelled",
  completed: "Completed",
  refunded: "Refunded",
  partially_refunded: "Partially refunded",
  paid: "Paid",
  failed: "Failed",
  pending: "Pending",
  succeeded: "Succeeded",
  payment_scheduled: "Payment scheduled",
  payment_method_required: "Payment method needed",
  payment_grace_period: "Payment needs attention",
  payment_failed: "Payment failed",
};

export function formatStatus(status: string | null | undefined): string {
  if (!status) return "—";
  if (STATUS_LABELS[status]) return STATUS_LABELS[status];
  // Graceful fallback for any unmapped value: "some_new_status" -> "Some new status"
  const spaced = status.replace(/_/g, " ");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/**
 * Minor units (e.g. 25500) + an ISO currency code (e.g. "GBP") ->
 * "£255.00". Uses Intl.NumberFormat with the currency the BACKEND
 * supplied, not a hardcoded "£" — HOST already handles multiple
 * currencies in its schema (booking_price_components.currency is
 * per-booking, not globally fixed), so a formatter that only ever
 * printed "£" would misrepresent a non-GBP booking rather than just
 * look plain. No client-side calculation: amountMinor is used exactly
 * as returned, only divided by 100 and formatted for display.
 */
/**
 * "15:00:00" (Postgres's own TIME column serialization via node-postgres)
 * or "15:00" (already-clean input, e.g. from an HTML time input) -> "15:00".
 * Display-only — never touches the stored value, matching the same
 * discipline as formatDate/formatStatus/formatCurrency above.
 */
export function formatTime(time: string | null | undefined): string {
  if (!time) return "—";
  return time.slice(0, 5);
}

export function formatCurrency(amountMinor: number | string | null | undefined, currencyCode: string | null | undefined): string {
  if (amountMinor == null || currencyCode == null) return "—";
  const amount = Number(amountMinor) / 100;
  try {
    return new Intl.NumberFormat("en-GB", { style: "currency", currency: currencyCode }).format(amount);
  } catch {
    // An unrecognized/malformed currency code — degrade to a plain,
    // still-correct number rather than crash the page.
    return `${amount.toFixed(2)} ${currencyCode}`;
  }
}
