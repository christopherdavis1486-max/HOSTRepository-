"use client";

import { useEffect, useRef, useState } from "react";
import { formatDate, formatStatus, formatCurrency } from "@/lib/presentation/formatters";
import { CustomerNav } from "@/components/CustomerNav";
import { useGuestI18n } from "@/lib/i18n/useGuestI18n";

/**
 * Polls the EXISTING, UNMODIFIED GET /api/bookings/[id] — same
 * non-negotiable as before: this page never reads Stripe's own
 * redirect_status and declares victory, it waits for the real webhook
 * to have updated the real booking record.
 *
 * No Stripe PaymentIntent/Charge IDs, no internal payment/host IDs, no
 * ledger data are read from the response at all — getBookingDetail()
 * itself already never returns provider_payment_intent_id in its mapped
 * shape (confirmed by reading tripHistory.ts directly before writing
 * this), so there's nothing to accidentally leak here even by mistake.
 */
export default function CheckoutReturnPage({ params }: { params: Promise<{ bookingId: string }> }) {
  const { gt } = useGuestI18n();
  const [bookingId, setBookingId] = useState<string | null>(null);
  const [booking, setBooking] = useState<any>(null);
  const [attempts, setAttempts] = useState(0);
  const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    params.then(({ bookingId: id }) => setBookingId(id));
  }, [params]);

  useEffect(() => {
    if (!bookingId) return;
    const poll = () => {
      fetch(`/api/bookings/${bookingId}`, { credentials: "include" })
        .then((r) => r.json())
        .then((data) => { if (data.success) setBooking(data.booking); })
        .catch(() => {});
    };
    poll();
    pollingRef.current = setInterval(() => { poll(); setAttempts((a) => a + 1); }, 2000);
    return () => { if (pollingRef.current) clearInterval(pollingRef.current); };
  }, [bookingId]);

  useEffect(() => {
    // FIXED while rewriting this page: previously this exact stop
    // condition existed but never actually stopped anything — it was a
    // separate effect with no reference to the interval, so polling
    // silently continued forever even after the booking was confirmed.
    // Now genuinely clears it.
    const isScheduledState = booking?.guestPaymentStatus === "payment_scheduled";
    const isFailureState = ["payment_grace_period", "payment_failed"].includes(booking?.guestPaymentStatus);
    // A recovery return can initially read the PREVIOUS failed attempt
    // while setup_intent.succeeded and payment_intent.succeeded are still
    // travelling through the webhook listener. Keep a bounded three-poll
    // window before treating a failure state as settled; this lets a real
    // recovery confirmation replace the stale decline automatically while
    // still stopping promptly for a genuinely failed new attempt.
    const settledFailureState = isFailureState && attempts >= 3;
    if ((booking?.status === "confirmed" || attempts > 15 || isScheduledState || settledFailureState) && pollingRef.current) {
      clearInterval(pollingRef.current);
      pollingRef.current = null;
    }
  }, [booking?.status, booking?.guestPaymentStatus, attempts]);

  const isScheduledPayment = booking?.guestPaymentStatus === "payment_scheduled";
  const needsPaymentAttention = ["payment_grace_period", "payment_failed"].includes(booking?.guestPaymentStatus);
  const timedOut = attempts > 15 && booking?.status === "pending_payment" && !isScheduledPayment && !needsPaymentAttention;
  const nights = booking ? Math.round((new Date(booking.checkOut).getTime() - new Date(booking.checkIn).getTime()) / 86400000) : null;

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
          --ivory: #F2ECDE; --warm-grey: #A79E8C; --brass: #C9974B;
          font-family: var(--font-body), system-ui, sans-serif;
          background: var(--ink); color: var(--ivory); min-height: 100vh;
        }
        .page-root * { box-sizing: border-box; }
        .display { font-family: var(--font-display), Georgia, serif; }
        .wrap { max-width: 520px; margin: 0 auto; padding: 60px 28px 80px; }
        .eyebrow { font-size: 11px; letter-spacing: 0.12em; text-transform: uppercase; color: var(--brass); text-align: center; margin-bottom: 10px; }
        h1 { font-size: 30px; font-weight: 400; text-align: center; margin-bottom: 32px; }
        .card { background: var(--graphite); border: 1px solid var(--stone); border-radius: 8px; padding: 24px; margin-bottom: 20px; }
        .card .property { font-family: var(--font-display), Georgia, serif; font-size: 19px; margin-bottom: 4px; }
        .card .location { color: var(--warm-grey); font-size: 14px; margin-bottom: 18px; }
        .row { display: flex; justify-content: space-between; gap: 12px; padding: 8px 0; border-top: 1px solid var(--stone); font-size: 14px; }
        .row .label { flex-shrink: 0; }
        .row > span:last-child { flex: 1; min-width: 0; text-align: right; word-break: break-word; }
        .row:first-of-type { border-top: none; }
        .row .label { color: var(--warm-grey); }
        .row > span:last-child { font-variant-numeric: tabular-nums; }
        .row.total { font-family: var(--font-body), system-ui, sans-serif; font-variant-numeric: tabular-nums; font-size: 17px; padding-top: 14px; margin-top: 4px; border-top: 1px solid var(--stone); }
        .row.total .label { color: var(--ivory); font-family: var(--font-body); font-size: 13px; }
        .policy-note { font-size: 13px; color: var(--warm-grey); line-height: 1.6; }
        .actions { display: flex; gap: 12px; margin-top: 24px; }
        .btn-primary { flex: 1; text-align: center; background: var(--brass); color: var(--ink); border: none; padding: 13px 20px; border-radius: 4px; font-family: var(--font-body); font-size: 14px; font-weight: 500; cursor: pointer; text-decoration: none; }
        .btn-secondary { flex: 1; text-align: center; background: transparent; color: var(--ivory); border: 1px solid var(--stone); padding: 13px 20px; border-radius: 4px; font-family: var(--font-body); font-size: 14px; cursor: pointer; text-decoration: none; }
        .state-block { text-align: center; color: var(--warm-grey); padding: 60px 0; }
        a:focus-visible { outline: 2px solid var(--brass); outline-offset: 3px; }
        @media(max-width:600px){.wrap{padding:40px 18px 60px}.actions{flex-direction:column}.card{padding:18px}}
      `}</style>

      <CustomerNav />

      <div className="wrap">
        {!booking && <div className="state-block" role="status" aria-live="polite">{gt("confirmingPayment")}</div>}

        {booking && booking.status === "pending_payment" && !timedOut && !isScheduledPayment && !needsPaymentAttention && (
          <>
            <div className="eyebrow">{gt("almostThere")}</div>
            <h1 className="display">{gt("confirmingPayment")}</h1>
            <p className="policy-note" style={{ textAlign: "center" }}>
              {gt("confirmationAutomatic")}
            </p>
          </>
        )}

        {isScheduledPayment && (
          <>
            <div className="eyebrow">{gt("paymentMethodSaved")}</div>
            <h1 className="display">{gt("allSetForNow")}</h1>
            <p className="policy-note" style={{ textAlign: "center" }}>
              {gt("savedMethodPrefix")}{" "}{booking.scheduledChargeDate ? formatDate(booking.scheduledChargeDate) : gt("closerDate")}, {gt("savedMethodSuffix")}
            </p>
            <div className="actions">
              <a href={`/trips/${bookingId}`} className="btn-primary">{gt("viewTrip")}</a>
            </div>
          </>
        )}

        {needsPaymentAttention && (
          <>
            <div className="eyebrow">{gt("paymentAttention")}</div>
            <h1 className="display">{gt("cardNotCharged")}</h1>
            <p className="policy-note" style={{ textAlign: "center" }}>
              {booking.paymentRecovery?.failureMessage ?? gt("attemptDeclined")}
              {booking.paymentRecovery?.nextRetryAt && <> HOST will retry automatically on {new Date(booking.paymentRecovery.nextRetryAt).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" })}.</>}
            </p>
            <div className="actions">
              <a href={`/checkout/${bookingId}`} className="btn-primary">{gt("updatePayment")}</a>
              <a href={`/trips/${bookingId}`} className="btn-secondary">{gt("viewTrip")}</a>
            </div>
          </>
        )}

        {timedOut && (
          <>
            <div className="eyebrow">{gt("longerExpected")}</div>
            <h1 className="display">{gt("waitingConfirmation")}</h1>
            <p className="policy-note" style={{ textAlign: "center" }}>
              Your payment method was saved successfully, but we haven't received confirmation that your card was charged yet. This can happen if payment processing is still in progress, or — in a local Stripe CLI test — if automated charging isn't enabled for this test run. Please check your trip in a few minutes, or contact support if this persists.
            </p>
            <div className="actions">
              <a href={`/trips/${bookingId}`} className="btn-primary">{gt("checkTripStatus")}</a>
            </div>
          </>
        )}

        {booking && booking.status === "confirmed" && (
          <>
            <div className="eyebrow">{gt("bookingConfirmed")}</div>
            <h1 className="display">{gt("allSet")}</h1>
            <div className="card">
              <div className="property display">{booking.propertyName}</div>
              <div className="location">{[booking.district, booking.city].filter(Boolean).join(", ")}</div>

              <div className="row"><span className="label">{gt("reference")}</span><span>{booking.id}</span></div>
              <div className="row"><span className="label">{gt("checkIn")}</span><span>{formatDate(booking.checkIn)}</span></div>
              <div className="row"><span className="label">{gt("checkOut")}</span><span>{formatDate(booking.checkOut)}</span></div>
              {nights != null && <div className="row"><span className="label">{gt("nights")}</span><span>{nights}</span></div>}
              <div className="row"><span className="label">{gt("guests")}</span><span>{booking.guests}</span></div>
              <div className="row"><span className="label">{gt("bookingStatus")}</span><span>{formatStatus(booking.status)}</span></div>
              <div className="row"><span className="label">{gt("paymentStatus")}</span><span>{formatStatus(booking.paymentFlowVersion === "separate_charges_delayed_v1" ? booking.guestPaymentStatus : booking.paymentStatus)}</span></div>
              <div className="row total"><span className="label">{gt("amountPaid")}</span><span>{formatCurrency(booking.breakdown?.guestTotalMinor, booking.breakdown?.currency)}</span></div>
            </div>

            {booking.cancellationPolicyTiers && (
              <div className="card">
                <div className="property display" style={{ fontSize: 16 }}>{gt("cancellationPolicy")}</div>
                <p className="policy-note">
                  {booking.cancellationPolicyTiers.map((t: any, i: number) => (
                    <span key={i}>{t.refundPercent}% refund if cancelled {t.cutoffHours}+ hours before check-in.{i < booking.cancellationPolicyTiers.length - 1 ? " " : ""}</span>
                  ))}
                </p>
              </div>
            )}

            <div className="actions">
              <a href={`/trips/${booking.id}`} className="btn-primary">{gt("viewTrip")}</a>
              <a href="/search" className="btn-secondary">{gt("browseDestinations")}</a>
            </div>
          </>
        )}

        {booking && !["pending_payment", "confirmed"].includes(booking.status) && (
          <>
            <div className="eyebrow">{gt("bookingStatus")}</div>
            <h1 className="display">{formatStatus(booking.status)}</h1>
            <div className="actions">
              <a href={`/trips/${booking.id}`} className="btn-primary">{gt("viewTrip")}</a>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
