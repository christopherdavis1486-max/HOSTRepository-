"use client";

import { useEffect, useState } from "react";
import { groupTrips } from "@/lib/booking/tripGrouping";
import { formatDate, formatStatus, formatCurrency } from "@/lib/presentation/formatters";
import { CustomerNav } from "@/components/CustomerNav";
import { useGuestI18n } from "@/lib/i18n/useGuestI18n";

/**
 * Calls the EXISTING, UNMODIFIED GET /api/bookings — already
 * session-scoped server-side (requireSession() + WHERE guest_id = ...
 * in listBookingsForGuest), so a guest can only ever receive their own
 * bookings; there's no client-side filtering standing in for real
 * authorization here.
 *
 * Grouping: UPCOMING (confirmed or pending_payment, check-in in the
 * future), PAST (check-in already passed, still confirmed/completed),
 * CANCELLED/REFUNDED (status reflects it directly). Computed from the
 * same `status` + `checkIn` fields the API already returns — no new
 * backend logic needed for this.
 */

type Trip = {
  id: string; propertyName: string; propertySlug: string | null;
  city: string; district: string | null; checkIn: string; checkOut: string;
  guests: number; status: string; paymentStatus: string | null;
  paymentFlowVersion: string; guestPaymentStatus: string | null;
  totalMinor: number | null; currency: string | null;
};

type State = "checking" | "unauthenticated" | "error" | "loaded";

export default function TripsPage() {
  const { gt } = useGuestI18n();
  const [trips, setTrips] = useState<Trip[]>([]);
  const [state, setState] = useState<State>("checking");

  useEffect(() => {
    fetch("/api/bookings", { credentials: "include" })
      .then(async (res) => {
        if (res.status === 401) { setState("unauthenticated"); return; }
        const data = await res.json();
        if (!data.success) { setState("error"); return; }
        setTrips(data.bookings);
        setState("loaded");
      })
      .catch(() => setState("error"));
  }, []);

  const { upcoming, past, cancelled } = groupTrips(trips);

  const renderGroup = (label: string, group: Trip[]) => (
    group.length > 0 && (
      <div className="group">
        <h2 className="display group-title">{label}</h2>
        <div className="trip-list">
          {group.map((t) => {
            const paymentState = t.paymentFlowVersion === "separate_charges_delayed_v1" ? t.guestPaymentStatus : t.paymentStatus;
            const needsPaymentMethod = paymentState === "payment_method_required";
            const needsAttention = paymentState === "payment_grace_period" || paymentState === "failed" || paymentState === "payment_failed";
            return (
            <a href={`/trips/${t.id}`} key={t.id} className={`trip-card ${needsAttention ? "needs-attention" : ""}`}>
              <div>
                <div className="trip-property display">{t.propertyName}</div>
                <div className="trip-location">{[t.district, t.city].filter(Boolean).join(", ")}</div>
                <div className="trip-dates">{formatDate(t.checkIn)} → {formatDate(t.checkOut)} · {t.guests} {t.guests === 1 ? gt("guest") : gt("guests")}</div>
              </div>
              <div className="trip-meta">
                <div className={`trip-status ${needsAttention ? "attention" : ""}`}>{formatStatus(t.status)} · {formatStatus(paymentState)}</div>
                {t.totalMinor != null && <div className="trip-total">{formatCurrency(t.totalMinor, t.currency)}</div>}
                <div className="trip-action">{needsPaymentMethod ? gt("resumePayment") : needsAttention ? gt("reviewPayment") : gt("viewTrip")} →</div>
              </div>
            </a>
          )})}
        </div>
      </div>
    )
  );

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
        .header { max-width: 800px; margin: 0 auto; padding: 8px 28px 32px; }
        .header h1 { font-size: 28px; font-weight: 400; }
        .header .discover { display: inline-block; margin-top: 8px; color: var(--brass); font-size: 13px; text-decoration: none; }
        .state-block { max-width: 800px; margin: 60px auto; padding: 0 28px; text-align: center; color: var(--warm-grey); }
        .error-box { background: rgba(224,121,107,0.12); border: 1px solid var(--error); color: var(--error); padding: 14px 18px; border-radius: 6px; display: inline-block; }
        .btn-primary { background: var(--brass); color: var(--ink); border: none; padding: 12px 22px; border-radius: 4px; font-family: var(--font-body); font-size: 14px; font-weight: 500; cursor: pointer; text-decoration: none; display: inline-block; margin-top: 16px; }

        .wrap { max-width: 800px; margin: 0 auto; padding: 0 28px 80px; }
        .group { margin-bottom: 36px; }
        .group-title { font-size: 13px; letter-spacing: 0.1em; text-transform: uppercase; color: var(--brass); font-weight: 400; margin-bottom: 14px; }
        .trip-list { display: flex; flex-direction: column; gap: 12px; }
        .trip-card { display: flex; justify-content: space-between; align-items: center; gap: 16px; text-decoration: none; color: inherit; background: var(--graphite); border: 1px solid var(--stone); border-radius: 6px; padding: 16px 18px; transition: border-color 0.15s; }
        .trip-card:hover, .trip-card:focus-visible { border-color: var(--brass); outline: none; }
        .trip-card.needs-attention { border-color: rgba(224,121,107,0.65); }
        .trip-property { font-size: 16px; margin-bottom: 2px; }
        .trip-location { font-size: 13px; color: var(--warm-grey); margin-bottom: 6px; }
        .trip-dates { font-size: 13px; color: var(--warm-grey); }
        .trip-meta { text-align: right; flex-shrink: 0; }
        .trip-status { font-size: 12px; color: var(--warm-grey); margin-bottom: 4px; }
        .trip-status.attention { color: var(--error); }
        .trip-total { font-family: var(--font-body), system-ui, sans-serif; font-variant-numeric: tabular-nums; font-size: 15px; color: var(--brass); }
        .trip-action { margin-top: 7px; font-size: 11px; color: var(--brass); }
        @media (max-width: 600px) {
          .top-link { padding: 18px 18px; }
          .header, .wrap { padding-left: 18px; padding-right: 18px; }
          .trip-card { flex-direction: column; align-items: flex-start; gap: 10px; }
          .trip-meta { text-align: left; }
        }
      `}</style>

      <CustomerNav />

      {state === "checking" && <div className="state-block" role="status" aria-live="polite">{gt("loadingTrips")}</div>}

      {state === "unauthenticated" && (
        <div className="state-block">
          <p style={{ marginBottom: 16 }}>{gt("signInTrips")}</p>
          <a href={`/login?returnTo=${encodeURIComponent("/trips")}`} className="btn-primary">{gt("signIn")}</a>
        </div>
      )}

      {state === "error" && (
        <div className="state-block"><div className="error-box">{gt("loadTripsError")}</div></div>
      )}

      {state === "loaded" && (
        <>
          <div className="header">
            <h1 className="display">{gt("myTrips")}</h1>
            <a href="/search" className="discover">{gt("browseDestinations")} →</a>
          </div>

          {trips.length === 0 && <div className="state-block">{gt("noTrips")} <a href="/search" style={{ color: "var(--brass)" }}>{gt("startExploring")}</a></div>}

          <div className="wrap">
            {renderGroup(gt("upcoming"), upcoming)}
            {renderGroup(gt("past"), past)}
            {renderGroup(gt("cancelledRefunded"), cancelled)}
          </div>
        </>
      )}
    </div>
  );
}
