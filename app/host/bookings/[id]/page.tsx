"use client";

import { useEffect, useState } from "react";
import { HostNav } from "@/components/HostNav";
import { MessageThread } from "@/components/MessageThread";
import { useHostI18n } from "@/lib/i18n/useHostI18n";

/**
 * Calls the NEW GET /api/host/bookings/[id] — real ownership-checked
 * (see that route's own doc comment for why it adds an explicit role
 * check on top of resolveBookingAccess()). Financial fields are read
 * directly from booking_price_components (via getHostBookingDetail())
 * — guestTotalMinor, hostCommissionMinor, and hostPayoutMinor are three
 * DISTINCT, already-computed values, never derived by subtracting one
 * from another here. payoutStatus reads the real payouts.status row,
 * not inferred from booking/payment status.
 */

type BookingDetail = {
  id: string; propertyId: string; propertyName: string; city: string; district: string | null;
  checkIn: string; checkOut: string; guests: number; status: string;
  guestName: string; guestEmail: string; paymentFlowVersion: string;
  paymentStatus: string | null; guestPaymentStatus: string | null;
  payoutStatus: string | null; entitlementStatus: string | null;
  breakdown: {
    currency: string; accommodationMinor: number; cleaningMinor: number; guestServiceFeeMinor: number;
    taxesMinor: number; guestTotalMinor: number; hostCommissionMinor: number; hostPayoutMinor: number;
  } | null;
};
type State = "loading" | "unauthenticated" | "forbidden" | "notFound" | "error" | "loaded";

export default function HostBookingDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { ht, hDate, hStatus, hCurrency } = useHostI18n();
  const [bookingId, setBookingId] = useState<string | null>(null);
  const [booking, setBooking] = useState<BookingDetail | null>(null);
  const [state, setState] = useState<State>("loading");

  useEffect(() => { params.then(({ id }) => setBookingId(id)); }, [params]);

  useEffect(() => {
    if (!bookingId) return;
    fetch(`/api/host/bookings/${bookingId}`, { credentials: "include" })
      .then(async (res) => {
        if (res.status === 401) { setState("unauthenticated"); return; }
        if (res.status === 403) { setState("forbidden"); return; }
        if (res.status === 404) { setState("notFound"); return; }
        const data = await res.json();
        if (!data.success) { setState("error"); return; }
        setBooking(data.booking);
        setState("loaded");
      })
      .catch(() => setState("error"));
  }, [bookingId]);

  const nights = booking ? Math.round((new Date(booking.checkOut).getTime() - new Date(booking.checkIn).getTime()) / 86400000) : null;

  // Payout label built entirely from real, authoritative statuses — never guessed.
  const isNewFlow = booking?.paymentFlowVersion === "separate_charges_delayed_v1";
  const effectivelyPaid = isNewFlow ? booking?.guestPaymentStatus === "paid" : booking?.paymentStatus === "paid";
  let payoutLabel = "—";
  if (booking) {
    if (booking.status === "cancelled" || booking.status === "refunded") payoutLabel = "Not payable — booking refunded";
    else if (isNewFlow) {
      // The real payout mechanism for a new-flow booking is
      // host_transfer_entitlements, not the legacy payouts table (which
      // this architecture never writes to at all).
      if (booking.entitlementStatus === "transfer_created") payoutLabel = "Payout sent";
      else if (booking.entitlementStatus === "transfer_claimed") payoutLabel = "Payout in progress";
      else if (booking.entitlementStatus === "transfer_failed") payoutLabel = "Payout failed";
      else if (booking.entitlementStatus === "cancelled_before_transfer") payoutLabel = "Payout cancelled";
      else if (booking.entitlementStatus === "entitled" || booking.entitlementStatus === "release_due") payoutLabel = "Payout pending";
      else if (!effectivelyPaid) payoutLabel = "Awaiting payment";
    }
    else if (booking.payoutStatus === "paid") payoutLabel = "Payout paid";
    else if (booking.payoutStatus === "in_transit") payoutLabel = "Payout in transit";
    else if (booking.payoutStatus === "scheduled") payoutLabel = "Payout pending";
    else if (booking.payoutStatus === "cancelled") payoutLabel = "Payout cancelled";
    else if (booking.payoutStatus === "failed") payoutLabel = "Payout failed";
    else if (!effectivelyPaid) payoutLabel = "Awaiting payment";
  }

  return (
    <div className="page-root">
      <link
        rel="stylesheet"
        href="https://fonts.googleapis.com/css2?family=Fraunces:ital,wght@0,400;0,500;1,400;1,500&family=Space+Grotesk:wght@400;500&display=swap"
      />
      <style>{`
        .page-root {
          --font-display: 'Fraunces', Georgia, serif;
          --font-body: 'Space Grotesk', system-ui, sans-serif;
          --ink: #14120E; --graphite: #1F1B15; --stone: #2A251C;
          --ivory: #F2ECDE; --warm-grey: #A79E8C; --brass: #C9974B; --error: #E0796B;
          font-family: var(--font-body), system-ui, sans-serif;
          background: var(--ink); color: var(--ivory); min-height: 100vh;
        }
        .page-root * { box-sizing: border-box; }
        .display { font-family: var(--font-display), Georgia, serif; }
        .top-link { display: block; padding: 24px 28px 0; }
        .top-link a { color: var(--warm-grey); font-size: 13px; text-decoration: none; }
        .state-block { max-width: 620px; margin: 60px auto; padding: 0 28px; text-align: center; color: var(--warm-grey); }
        .error-box { background: rgba(224,121,107,0.12); border: 1px solid var(--error); color: var(--error); padding: 14px 18px; border-radius: 6px; display: inline-block; }
        .btn-primary { background: var(--brass); color: var(--ink); border: none; padding: 12px 22px; border-radius: 4px; font-family: var(--font-body); font-size: 14px; font-weight: 500; cursor: pointer; text-decoration: none; display: inline-block; margin-top: 16px; }

        .wrap { max-width: 640px; margin: 0 auto; padding: 8px 28px 80px; }
        h1.display { font-size: 24px; font-weight: 400; margin: 20px 0 4px; }
        .location-line { color: var(--warm-grey); font-size: 14px; margin-bottom: 20px; }
        .card { background: var(--graphite); border: 1px solid var(--stone); border-radius: 8px; padding: 22px; margin-bottom: 18px; }
        .card h2 { font-size: 15px; font-weight: 400; margin-bottom: 12px; letter-spacing: 0.04em; text-transform: uppercase; color: var(--brass); }
        .row { display: flex; justify-content: space-between; gap: 12px; padding: 7px 0; font-size: 14px; border-top: 1px solid var(--stone); }
        .row:first-of-type { border-top: none; }
        .row .label { color: var(--warm-grey); flex-shrink: 0; }
        .row > span:last-child { text-align: right; word-break: break-word; font-variant-numeric: tabular-nums; }
        .row.subtotal { padding-top: 10px; border-top: 1px solid var(--stone); margin-top: 2px; }
        .row.subtotal .label { color: var(--ivory); }
        .row.total { font-family: var(--font-body), system-ui, sans-serif; font-variant-numeric: tabular-nums; font-size: 16px; padding-top: 12px; border-top: 1px solid var(--stone); margin-top: 4px; }
        .row.total .label { font-family: var(--font-body); font-size: 13px; }
        .row.host-amount { color: var(--brass); }
        .back-link { display: block; margin-top: 20px; color: var(--warm-grey); font-size: 13px; text-decoration: none; }
        a:focus-visible, button:focus-visible { outline: 2px solid var(--brass); outline-offset: 3px; }
        @media (max-width: 600px) {
          .top-link { padding-left: 18px; padding-right: 18px; }
          .wrap { padding-left: 18px; padding-right: 18px; }
          .card { padding: 18px; }
        }
      `}</style>

      <div className="top-link"><a href="/host/bookings">← {ht("Back to Bookings")}</a></div>

      {state === "loading" && <div className="state-block">{ht("Loading booking…")}</div>}

      {state === "unauthenticated" && (
        <div className="state-block">
          <p style={{ marginBottom: 16 }}>{ht("Sign in to your host account.")}</p>
          <a href={`/login?returnTo=${encodeURIComponent(`/host/bookings/${bookingId ?? ""}`)}`} className="btn-primary">{ht("Sign in")}</a>
        </div>
      )}

      {(state === "forbidden" || state === "notFound") && (
        <div className="state-block"><div className="error-box">{ht("This booking isn't available.")}</div></div>
      )}

      {state === "error" && (
        <div className="state-block"><div className="error-box">{ht("Something went wrong loading this booking. Please try again shortly.")}</div></div>
      )}

      {state === "loaded" && booking && (
        <>
          <HostNav active="bookings" />
          <div className="wrap">
            <h1 className="display">{booking.propertyName}</h1>
            <div className="location-line">{[booking.district, booking.city].filter(Boolean).join(", ")}</div>

            <div className="card">
              <h2>{ht("Booking")}</h2>
              <div className="row"><span className="label">{ht("Reference")}</span><span>{booking.id}</span></div>
              <div className="row"><span className="label">{ht("Check-in")}</span><span>{hDate(booking.checkIn)}</span></div>
              <div className="row"><span className="label">{ht("Check-out")}</span><span>{hDate(booking.checkOut)}</span></div>
              {nights != null && <div className="row"><span className="label">{ht("Nights")}</span><span>{nights}</span></div>}
              <div className="row"><span className="label">{ht("Guests")}</span><span>{booking.guests}</span></div>
              <div className="row"><span className="label">{ht("Booking status")}</span><span>{hStatus(booking.status)}</span></div>
              <div className="row"><span className="label">{ht("Payment status")}</span><span>{hStatus(isNewFlow ? booking.guestPaymentStatus : booking.paymentStatus)}</span></div>
            </div>

            <div className="card">
              <h2>{ht("Guest")}</h2>
              <div className="row"><span className="label">{ht("Name")}</span><span>{booking.guestName}</span></div>
              <div className="row"><span className="label">{ht("Email")}</span><span>{booking.guestEmail}</span></div>
            </div>

            {booking.breakdown && (
              <div className="card">
                <h2>{ht("Price breakdown")}</h2>
                <div className="row"><span className="label">{ht("Accommodation")}</span><span>{hCurrency(booking.breakdown.accommodationMinor, booking.breakdown.currency)}</span></div>
                <div className="row"><span className="label">{ht("Cleaning fee")}</span><span>{hCurrency(booking.breakdown.cleaningMinor, booking.breakdown.currency)}</span></div>
                <div className="row"><span className="label">{ht("Guest service fee")}</span><span>{hCurrency(booking.breakdown.guestServiceFeeMinor, booking.breakdown.currency)}</span></div>
                <div className="row"><span className="label">{ht("Taxes")}</span><span>{hCurrency(booking.breakdown.taxesMinor, booking.breakdown.currency)}</span></div>
                <div className="row subtotal"><span className="label">{ht("Guest total")}</span><span>{hCurrency(booking.breakdown.guestTotalMinor, booking.breakdown.currency)}</span></div>
                <div className="row"><span className="label">{ht("HOST commission")}</span><span>{hCurrency(booking.breakdown.hostCommissionMinor, booking.breakdown.currency)}</span></div>
                <div className="row host-amount total"><span className="label">{ht("Your payout amount")}</span><span>{hCurrency(booking.breakdown.hostPayoutMinor, booking.breakdown.currency)}</span></div>
              </div>
            )}

            <div className="card">
              <h2>{ht("Payout")}</h2>
              <div className="row"><span className="label">{ht("Status")}</span><span>{payoutLabel}</span></div>
            </div>

            <div className="card" style={{ padding: 0, background: "transparent", border: "none" }}>
              <MessageThread bookingId={booking.id} viewerRole="host" />
            </div>

            <a href="/host/bookings" className="back-link">← {ht("Back to Bookings")}</a>
          </div>
        </>
      )}
    </div>
  );
}
