"use client";

import { useEffect, useState } from "react";
import { formatDate, formatStatus, formatCurrency } from "@/lib/presentation/formatters";
import { MessageThread } from "@/components/MessageThread";
import { useGuestI18n } from "@/lib/i18n/useGuestI18n";

/**
 * Calls three EXISTING/NEW-but-read-only endpoints, none of them
 * modified in behavior from what they already did:
 *   GET /api/bookings/[id]              — existing, IDOR-protected via resolveBookingAccess
 *   GET /api/bookings/[id]/cancellation-quote — NEW this batch, read-only, reuses calculateCancellation()
 *   POST /api/bookings/[id]/cancel      — existing, unmodified contract
 *
 * Cancellation flow is deliberately two-step: fetching a quote never
 * cancels anything by itself (structurally impossible — that route
 * contains no writes at all), and the real cancel call only fires after
 * the guest explicitly confirms in a modal showing the exact numbers
 * from the quote.
 *
 * Refund state is read directly from the booking/refunds data, never
 * inferred from "the cancel call returned success" — cancelling and the
 * refund actually completing are two different, asynchronous facts, and
 * this page keeps them visually distinct.
 */

type BookingDetail = {
  id: string; propertyName: string; city: string; district: string | null;
  checkIn: string; checkOut: string; guests: number; status: string; paymentStatus: string | null;
  paymentFlowVersion: string; guestPaymentStatus: string | null;
  paymentRecovery: { failureCode: string | null; failureMessage: string | null; nextRetryAt: string | null; gracePeriodExpiresAt: string | null } | null;
  breakdown: { currency: string; accommodationMinor: number; cleaningMinor: number; guestServiceFeeMinor: number; taxesMinor: number; guestTotalMinor: number };
  cancellationPolicyTiers: { cutoffHours: number; refundPercent: number }[] | null;
  refunds: { amountMinor: number; currency: string; status: string; createdAt: string }[];
};

type Quote = {
  eligible: boolean;
  reason?: string;
  refundPercent?: number;
  refundableMinor?: number;
  hostRetainedMinor?: number;
  currency: string;
};

type LoadState = "loading" | "unauthenticated" | "forbidden" | "notFound" | "error" | "loaded";

export default function TripDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { gt } = useGuestI18n();
  const [bookingId, setBookingId] = useState<string | null>(null);
  const [booking, setBooking] = useState<BookingDetail | null>(null);
  const [loadState, setLoadState] = useState<LoadState>("loading");

  const [quote, setQuote] = useState<Quote | null>(null);
  const [quoteLoading, setQuoteLoading] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [cancelError, setCancelError] = useState<string | null>(null);
  const [historyAction, setHistoryAction] = useState<"discard" | "archive" | null>(null);
  const [historyError, setHistoryError] = useState<string | null>(null);

  useEffect(() => { params.then(({ id }) => setBookingId(id)); }, [params]);

  const loadBooking = () => {
    if (!bookingId) return;
    fetch(`/api/bookings/${bookingId}`, { credentials: "include" })
      .then(async (res) => {
        if (res.status === 401) { setLoadState("unauthenticated"); return; }
        if (res.status === 403) { setLoadState("forbidden"); return; }
        if (res.status === 404) { setLoadState("notFound"); return; }
        const data = await res.json();
        if (!data.success) { setLoadState("error"); return; }
        setBooking(data.booking);
        setLoadState("loaded");
      })
      .catch(() => setLoadState("error"));
  };

  useEffect(loadBooking, [bookingId]);

  const requestQuote = () => {
    if (!bookingId) return;
    setQuoteLoading(true);
    fetch(`/api/bookings/${bookingId}/cancellation-quote`, { credentials: "include" })
      .then((r) => r.json())
      .then((data) => {
        if (data.success) { setQuote(data.quote); setShowConfirm(true); }
        setQuoteLoading(false);
      })
      .catch(() => setQuoteLoading(false));
  };

  const confirmCancel = async () => {
    if (!bookingId) return;
    setCancelling(true);
    setCancelError(null);
    try {
      const res = await fetch(`/api/bookings/${bookingId}/cancel`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({}),
      });
      const data = await res.json();
      if (!data.success) {
        setCancelError(data.error?.message ?? "Couldn't cancel this booking. Please try again.");
        setCancelling(false);
        return;
      }
      setShowConfirm(false);
      setCancelling(false);
      loadBooking(); // refresh with the real, backend-confirmed post-cancellation state
    } catch {
      setCancelError("Something went wrong reaching the server. Please try again.");
      setCancelling(false);
    }
  };

  const manageHistory = async (action: "discard" | "archive") => {
    if (!bookingId) return;
    const prompt = action === "discard"
      ? "Discard this unpaid booking? Its reserved dates will be released and it will disappear from My Trips. Payment and audit records will be retained."
      : "Remove this booking from My Trips? The booking record will be retained.";
    if (!window.confirm(prompt)) return;
    setHistoryAction(action);
    setHistoryError(null);
    try {
      const res = await fetch(`/api/bookings/${bookingId}/${action}`, { method: "POST", credentials: "include" });
      const data = await res.json();
      if (!data.success) {
        setHistoryError(data.error?.message ?? "Couldn't update your trip history.");
        setHistoryAction(null);
        return;
      }
      window.location.href = "/trips";
    } catch {
      setHistoryError("Something went wrong reaching the server.");
      setHistoryAction(null);
    }
  };

  const cancellable = booking && booking.status === "confirmed";
  const discardable = booking && booking.status === "pending_payment";
  const archivable = booking && ["cancelled", "completed", "refunded"].includes(booking.status);
  const reviewable = booking && booking.status === "completed";

  // Refund state: never says "completed" just because cancel succeeded —
  // reads the actual refunds array, which only reflects reality once the
  // real Stripe webhook has updated it.
  const latestRefund = booking?.refunds?.[0];
  let refundStateLabel: string | null = null;
  if (booking?.status === "cancelled" || booking?.status === "refunded") {
    if (!latestRefund) refundStateLabel = "No refund due";
    else if (latestRefund.status === "succeeded") refundStateLabel = "Refund completed";
    else if (latestRefund.status === "pending") refundStateLabel = "Refund processing";
    else if (latestRefund.status === "failed") refundStateLabel = "Refund failed — support required";
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
        .top-link { display: block; padding: 24px 28px; }
        .top-link a { color: var(--warm-grey); font-size: 13px; text-decoration: none; }
        .wrap { max-width: 620px; margin: 0 auto; padding: 8px 28px 80px; }
        .state-block { max-width: 620px; margin: 60px auto; padding: 0 28px; text-align: center; color: var(--warm-grey); }
        .error-box { background: rgba(224,121,107,0.12); border: 1px solid var(--error); color: var(--error); padding: 14px 18px; border-radius: 6px; display: inline-block; }
        .btn-primary { background: var(--brass); color: var(--ink); border: none; padding: 12px 22px; border-radius: 4px; font-family: var(--font-body); font-size: 14px; font-weight: 500; cursor: pointer; text-decoration: none; display: inline-block; }

        .property display { font-size: 26px; }
        h1.display { font-size: 26px; font-weight: 400; margin-bottom: 4px; }
        .location-line { color: var(--warm-grey); font-size: 14px; margin-bottom: 24px; }
        .card { background: var(--graphite); border: 1px solid var(--stone); border-radius: 8px; padding: 22px; margin-bottom: 18px; }
        .card h2 { font-size: 15px; font-weight: 400; margin-bottom: 12px; letter-spacing: 0.04em; text-transform: uppercase; color: var(--brass); }
        .row { display: flex; justify-content: space-between; gap: 12px; padding: 7px 0; font-size: 14px; border-top: 1px solid var(--stone); }
        .row .label { flex-shrink: 0; }
        .row > span:last-child { flex: 1; min-width: 0; text-align: right; word-break: break-word; }
        .row:first-of-type { border-top: none; }
        .row .label { color: var(--warm-grey); }
        .row > span:last-child { font-variant-numeric: tabular-nums; }
        .row.total { font-family: var(--font-body), system-ui, sans-serif; font-variant-numeric: tabular-nums; font-size: 16px; padding-top: 12px; border-top: 1px solid var(--stone); margin-top: 4px; }
        .row.total .label { font-family: var(--font-body); font-size: 13px; }
        .refund-badge { display: inline-block; font-size: 12px; padding: 5px 12px; border-radius: 999px; margin-top: 6px; }
        .refund-badge.completed { background: rgba(201,151,75,0.15); color: var(--brass); }
        .refund-badge.processing { background: rgba(167,158,140,0.15); color: var(--warm-grey); }
        .refund-badge.failed { background: rgba(224,121,107,0.15); color: var(--error); }
        .policy-note { font-size: 13px; color: var(--warm-grey); line-height: 1.7; }
        .btn-danger-outline { background: transparent; border: 1px solid var(--error); color: var(--error); padding: 11px 18px; border-radius: 4px; font-family: var(--font-body); font-size: 13px; cursor: pointer; }
        .btn-danger-outline:disabled { opacity: 0.6; cursor: wait; }
        .btn-secondary { background: transparent; border: 1px solid var(--brass); color: var(--brass); padding: 11px 18px; border-radius: 4px; font-family: var(--font-body); font-size: 13px; cursor: pointer; margin-bottom: 12px; }
        .back-link { display: block; margin-top: 20px; color: var(--warm-grey); font-size: 13px; text-decoration: none; }
        .history-tools { margin-top: 18px; padding-top: 18px; border-top: 1px solid var(--stone); }
        .history-tools h2 { font-size: 12px; color: var(--warm-grey); text-transform: uppercase; letter-spacing: .08em; margin-bottom: 8px; }
        .history-tools p { font-size: 12px; color: var(--warm-grey); line-height: 1.55; margin-bottom: 10px; }
        .recovery-card { border-color: var(--error); }
        .recovery-card h2 { color: var(--error); }
        .recovery-card p { color: var(--warm-grey); font-size: 13px; line-height: 1.65; margin: 0 0 12px; }
        .recovery-card strong { color: var(--ivory); font-weight: 500; }
        a:focus-visible, button:focus-visible { outline: 2px solid var(--brass); outline-offset: 3px; }
        @media (max-width: 600px) {
          .top-link { padding: 18px; }
          .wrap { padding-left: 18px; padding-right: 18px; }
          .card { padding: 18px; }
          .row { gap: 16px; }
        }

        .modal-backdrop { position: fixed; inset: 0; background: rgba(0,0,0,0.6); display: flex; align-items: center; justify-content: center; padding: 20px; z-index: 10; }
        .modal { background: var(--graphite); border: 1px solid var(--stone); border-radius: 8px; padding: 26px; max-width: 420px; width: 100%; }
        .modal h2 { font-family: var(--font-display), Georgia, serif; font-size: 20px; font-weight: 400; margin-bottom: 16px; }
        .modal-actions { display: flex; gap: 10px; margin-top: 20px; }
        .btn-secondary-modal { flex: 1; background: transparent; border: 1px solid var(--stone); color: var(--ivory); padding: 11px; border-radius: 4px; font-family: var(--font-body); font-size: 14px; cursor: pointer; }
        .btn-confirm-cancel { flex: 1; background: var(--error); color: var(--ink); border: none; padding: 11px; border-radius: 4px; font-family: var(--font-body); font-size: 14px; font-weight: 500; cursor: pointer; }
        .btn-confirm-cancel:disabled { opacity: 0.6; cursor: wait; }
      `}</style>

      <div className="top-link"><a href="/trips">← Back to My Trips</a></div>

      {loadState === "loading" && <div className="state-block">{gt("loadingTrip")}</div>}

      {loadState === "unauthenticated" && (
        <div className="state-block">
          <p style={{ marginBottom: 16 }}>{gt("signInViewTrip")}</p>
          <a href={`/login?returnTo=${encodeURIComponent(`/trips/${bookingId ?? ""}`)}`} className="btn-primary">{gt("signIn")}</a>
        </div>
      )}

      {(loadState === "forbidden" || loadState === "notFound") && (
        <div className="state-block">
          <div className="error-box">{gt("tripUnavailable")}</div>
        </div>
      )}

      {loadState === "error" && (
        <div className="state-block"><div className="error-box">{gt("loadTripError")}</div></div>
      )}

      {loadState === "loaded" && booking && (
        <div className="wrap">
          <h1 className="display">{booking.propertyName}</h1>
          <div className="location-line">{[booking.district, booking.city].filter(Boolean).join(", ")}</div>

          <div className="card">
            <div className="row"><span className="label">{gt("reference")}</span><span>{booking.id}</span></div>
            <div className="row"><span className="label">{gt("checkIn")}</span><span>{formatDate(booking.checkIn)}</span></div>
            <div className="row"><span className="label">{gt("checkOut")}</span><span>{formatDate(booking.checkOut)}</span></div>
            <div className="row"><span className="label">{gt("guests")}</span><span>{booking.guests}</span></div>
            <div className="row"><span className="label">{gt("bookingStatus")}</span><span>{formatStatus(booking.status)}</span></div>
            <div className="row"><span className="label">{gt("paymentStatus")}</span><span>{formatStatus(booking.paymentFlowVersion === "separate_charges_delayed_v1" ? booking.guestPaymentStatus : booking.paymentStatus)}</span></div>
          </div>

          {booking.guestPaymentStatus === "payment_grace_period" && booking.paymentRecovery && (
            <div className="card recovery-card" role="alert">
              <h2>{gt("paymentAttention")}</h2>
              <p>
                Your last payment attempt was declined{booking.paymentRecovery.failureMessage ? `: ${booking.paymentRecovery.failureMessage}` : "."}
                {booking.paymentRecovery.nextRetryAt && (
                  <> We will retry automatically on <strong>{new Date(booking.paymentRecovery.nextRetryAt).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" })}</strong>.</>
                )}
              </p>
              {booking.paymentRecovery.gracePeriodExpiresAt && (
                <p>Your booking is protected during the grace period until <strong>{new Date(booking.paymentRecovery.gracePeriodExpiresAt).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" })}</strong>.</p>
              )}
              <a href={`/checkout/${booking.id}`} className="btn-primary">{gt("updatePayment")}</a>
            </div>
          )}

          {booking.guestPaymentStatus === "payment_method_required" && (
            <div className="card">
              <h2>{gt("completePaymentSetup")}</h2>
              <p className="policy-note" style={{ marginBottom: 14 }}>
                Add a secure payment method to complete this booking. Card details are collected directly by Stripe and are not stored by HOST.
              </p>
              <a href={`/checkout/${booking.id}`} className="btn-primary">{gt("resumePayment")}</a>
            </div>
          )}

          <div className="card">
            <h2>{gt("priceBreakdown")}</h2>
            <div className="row"><span className="label">{gt("accommodation")}</span><span>{formatCurrency(booking.breakdown.accommodationMinor, booking.breakdown.currency)}</span></div>
            <div className="row"><span className="label">{gt("cleaningFee")}</span><span>{formatCurrency(booking.breakdown.cleaningMinor, booking.breakdown.currency)}</span></div>
            <div className="row"><span className="label">{gt("serviceFee")}</span><span>{formatCurrency(booking.breakdown.guestServiceFeeMinor, booking.breakdown.currency)}</span></div>
            <div className="row"><span className="label">{gt("taxes")}</span><span>{formatCurrency(booking.breakdown.taxesMinor, booking.breakdown.currency)}</span></div>
            <div className="row total"><span className="label">{(booking.paymentFlowVersion === "separate_charges_delayed_v1" ? booking.guestPaymentStatus === "paid" : booking.paymentStatus === "paid") ? gt("totalPaid") : gt("bookingTotal")}</span><span>{formatCurrency(booking.breakdown.guestTotalMinor, booking.breakdown.currency)}</span></div>
          </div>

          {booking.cancellationPolicyTiers && (
            <div className="card">
              <h2>{gt("cancellationPolicy")}</h2>
              <p className="policy-note">
                {booking.cancellationPolicyTiers.map((t, i) => (
                  <span key={i}>{t.refundPercent}% refund if cancelled {t.cutoffHours}+ hours before check-in.{i < booking.cancellationPolicyTiers!.length - 1 ? " " : ""}</span>
                ))}
              </p>
            </div>
          )}

          {refundStateLabel && (
            <div className="card">
              <h2>{gt("refundStatus")}</h2>
              <span className={`refund-badge ${refundStateLabel === "Refund completed" ? "completed" : refundStateLabel === "Refund failed — support required" ? "failed" : "processing"}`}>
                {refundStateLabel}
              </span>
              {latestRefund && refundStateLabel !== "No refund due" && (
                <p className="policy-note" style={{ marginTop: 10 }}>
                  {formatCurrency(latestRefund.amountMinor, latestRefund.currency)}
                </p>
              )}
            </div>
          )}

          <div className="card" style={{ padding: 0, background: "transparent", border: "none" }}>
            <MessageThread bookingId={booking.id} viewerRole="guest" />
          </div>

          {reviewable && (
            <a href={`/trips/${booking.id}/review`} className="btn-secondary" style={{ display: "inline-block", textDecoration: "none", textAlign: "center" }}>
              Leave a review
            </a>
          )}

          {cancellable && !showConfirm && (
            <button className="btn-danger-outline" onClick={requestQuote} disabled={quoteLoading}>
              {quoteLoading ? gt("checking") : gt("cancelBooking")}
            </button>
          )}

          {(discardable || archivable) && (
            <div className="history-tools">
              <h2>{gt("tripHistory")}</h2>
              <p>{discardable ? "Use this only for an abandoned unpaid test or checkout. No booking or financial record is deleted." : "Hide this finished booking from My Trips. Its record is kept."}</p>
              <button className="btn-danger-outline" onClick={() => manageHistory(discardable ? "discard" : "archive")} disabled={historyAction !== null}>
                {historyAction ? "Updating…" : discardable ? "Discard unpaid booking" : "Remove from My Trips"}
              </button>
              {historyError && <div className="error-box" style={{ marginTop: 12, display: "block" }}>{historyError}</div>}
            </div>
          )}

          <a href="/trips" className="back-link">← Back to My Trips</a>

          {showConfirm && quote && (
            <div className="modal-backdrop" onClick={() => !cancelling && setShowConfirm(false)}>
              <div className="modal" onClick={(e) => e.stopPropagation()}>
                {quote.eligible ? (
                  <>
                    <h2>{gt("cancelBooking")}?</h2>
                    <div className="row"><span className="label">{gt("refund")}</span><span>{quote.refundPercent}%</span></div>
                    <div className="row"><span className="label">{gt("refundAmount")}</span><span>{formatCurrency(quote.refundableMinor, quote.currency)}</span></div>
                    <div className="row"><span className="label">{gt("amountRetained")}</span><span>{formatCurrency(quote.hostRetainedMinor, quote.currency)}</span></div>
                    {cancelError && <div className="error-box" style={{ marginTop: 14, display: "block" }}>{cancelError}</div>}
                    <div className="modal-actions">
                      <button className="btn-secondary-modal" onClick={() => setShowConfirm(false)} disabled={cancelling}>{gt("keepBooking")}</button>
                      <button className="btn-confirm-cancel" onClick={confirmCancel} disabled={cancelling}>
                        {cancelling ? gt("cancelling") : gt("confirmCancellation")}
                      </button>
                    </div>
                  </>
                ) : (
                  <>
                    <h2>{gt("cannotCancel")}</h2>
                    <p className="policy-note">{quote.reason}</p>
                    <div className="modal-actions">
                      <button className="btn-secondary-modal" onClick={() => setShowConfirm(false)}>{gt("close")}</button>
                    </div>
                  </>
                )}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
