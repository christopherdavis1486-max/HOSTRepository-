type SubmissionCheck =
  | { allowed: true }
  | { allowed: false; message: string };

const UNVERIFIED = "We couldn't verify that this booking is ready for payment. Return to My Trips to check its status.";

export async function checkLegacyCheckoutSubmission(
  bookingId: string,
  fetcher: typeof fetch = fetch
): Promise<SubmissionCheck> {
  try {
    const response = await fetcher("/api/bookings/" + encodeURIComponent(bookingId), {
      credentials: "include",
      cache: "no-store",
      headers: { "Cache-Control": "no-cache" },
    });
    if (!response.ok) return { allowed: false, message: UNVERIFIED };
    const data = await response.json();
    const booking = data?.booking;
    if (data?.success !== true || booking?.id !== bookingId ||
        booking.paymentFlowVersion !== "destination_charge_legacy") {
      return { allowed: false, message: UNVERIFIED };
    }
    if (booking.status !== "pending_payment") {
      return { allowed: false, message: "This booking is no longer awaiting checkout payment. Return to My Trips to check its status." };
    }
    if (booking.checkoutHoldExpired === true) {
      return { allowed: false, message: "Your reservation hold has expired. Return to the property page and select your accommodation and dates again. Availability and prices will be checked again." };
    }
    if (booking.checkoutHoldExpired !== false ||
        !["pending", "failed"].includes(booking.paymentStatus)) {
      return { allowed: false, message: UNVERIFIED };
    }
    return { allowed: true };
  } catch {
    return { allowed: false, message: UNVERIFIED };
  }
}
