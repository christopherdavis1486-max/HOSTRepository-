export type NotificationType =
  | "booking_confirmed"
  | "payment_failed"
  | "booking_cancelled"
  | "refund_issued"
  | "new_message"
  | "checkin_reminder"
  | "checkin_info_available"
  | "review_request"
  | "host_new_booking";

export type TemplateContext = {
  guestName?: string;
  hostName?: string;
  propertyName?: string;
  checkIn?: string;
  checkOut?: string;
  bookingRef?: string;
  refundAmount?: string;
  checkInTime?: string;
  checkInInstructions?: string;
  /** FOUND during Batch 8's audit: no notification type has ever
   *  included a real destination URL, system-wide — this is the first,
   *  added specifically for review_request since a guest needs somewhere
   *  to actually act on "please review your stay". Deliberately not
   *  retrofitted onto every other type — that's a broader change this
   *  batch doesn't need. */
  reviewUrl?: string;
};

export type RenderedNotification = { subject: string; body: string };

/** Every notification type's wording lives here once — the in-app system
 *  message, the email subject, and the email body all render from the
 *  same template, so "your booking is confirmed" can't drift into two
 *  different phrasings across channels. */
export function renderNotification(type: NotificationType, ctx: TemplateContext): RenderedNotification {
  switch (type) {
    case "booking_confirmed":
      return {
        subject: `Your booking at ${ctx.propertyName} is confirmed`,
        body: `Your booking is confirmed. ${ctx.propertyName}, ${ctx.checkIn} → ${ctx.checkOut}. Reference ${ctx.bookingRef}.`,
      };
    case "payment_failed":
      return {
        subject: `We couldn't complete your payment`,
        body: `Your payment attempt for ${ctx.propertyName} didn't go through. Your booking isn't confirmed yet — you can retry payment from your trip.`,
      };
    case "booking_cancelled":
      return {
        subject: `Your booking at ${ctx.propertyName} has been cancelled`,
        body: `Your booking (${ctx.bookingRef}) has been cancelled.${ctx.refundAmount ? ` A refund of ${ctx.refundAmount} has been initiated.` : ""}`,
      };
    case "refund_issued":
      return {
        subject: `Your refund has been issued`,
        body: `A refund of ${ctx.refundAmount} for booking ${ctx.bookingRef} has been issued to your original payment method.`,
      };
    case "new_message":
      return {
        subject: `New message about ${ctx.propertyName}`,
        body: `You have a new message about your stay at ${ctx.propertyName}.`,
      };
    case "checkin_reminder":
      return {
        subject: `Your stay begins tomorrow`,
        body: `Your stay begins tomorrow. ${ctx.propertyName}, check-in from ${ctx.checkInTime ?? "the property's usual check-in time"}.`,
      };
    case "checkin_info_available":
      return {
        subject: `Check-in information for ${ctx.propertyName}`,
        body: `Check-in information is now available for your upcoming stay.${ctx.checkInInstructions ? ` ${ctx.checkInInstructions}` : ""}`,
      };
    case "review_request":
      return {
        subject: `How was your stay at ${ctx.propertyName}?`,
        body: `How was your stay? Your feedback helps other guests and the host. Leave a review: ${ctx.reviewUrl ?? `(booking ${ctx.bookingRef})`}`,
      };
    case "host_new_booking":
      return {
        subject: `New booking for ${ctx.propertyName}`,
        body: `You have a new confirmed booking. ${ctx.propertyName}, ${ctx.checkIn} → ${ctx.checkOut}. Reference ${ctx.bookingRef}.`,
      };
  }
}
