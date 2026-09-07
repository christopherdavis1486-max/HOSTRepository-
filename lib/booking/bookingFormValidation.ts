/**
 * Pure client-side validation for the booking panel on
 * app/stays/[slug]/page.tsx — deliberately mirrors, but does NOT
 * replace, the backend's own authoritative validation
 * (createBookingSchema in lib/validation/schemas.ts, and
 * createBooking.ts's own availability/pricing logic). This exists only
 * to give the user immediate feedback before a request round-trip; the
 * backend remains the source of truth for whether a booking can
 * actually be created, per the project's standing non-negotiable rule.
 */
export type BookingFormInput = {
  checkIn: string;
  checkOut: string;
  guests: number;
  maxGuests: number;
  guestName: string;
  guestEmail: string;
};

export function validateBookingForm(input: BookingFormInput): string | null {
  if (!input.checkIn) return "Select a check-in date.";
  if (!input.checkOut) return "Select a check-out date.";
  if (input.checkOut <= input.checkIn) return "Check-out must be after check-in.";
  if (input.guests < 1) return "At least 1 guest is required.";
  if (input.guests > input.maxGuests) return `This property accommodates up to ${input.maxGuests} guests.`;
  if (!input.guestName.trim()) return "Enter your full name.";
  if (!input.guestEmail.trim()) return "Enter your email.";
  return null;
}
