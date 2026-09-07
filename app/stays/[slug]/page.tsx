"use client";

import { useEffect, useRef, useState } from "react";
import { CustomerNav } from "@/components/CustomerNav";
import { validateBookingForm } from "@/lib/booking/bookingFormValidation";
import { interpretPropertyResponse } from "./interpretPropertyResponse";
import {
  initialFavouriteState, interpretFavouritesLoad, interpretFavouriteMutation,
  beginFavouriteAction, completeFavouriteAction, buildLoginRedirectUrl,
} from "./favouriteControl";
import { formatTime, formatCurrency } from "@/lib/presentation/formatters";
import { AvailabilityCalendar } from "@/components/AvailabilityCalendar";
import { PropertyReviews } from "@/components/PropertyReviews";
import { useGuestI18n } from "@/lib/i18n/useGuestI18n";

/**
 * Calls the EXISTING GET /api/properties/[slug-or-id] (extended for this
 * batch to accept either) and the EXISTING, UNMODIFIED POST /api/bookings
 * — no changes to either contract. `params` handling matches the
 * established real pattern already used by
 * app/checkout/[bookingId]/page.tsx (a Promise, resolved in useEffect),
 * not guessed at.
 *
 * Idempotency key: generated ONCE via useRef's lazy initializer, not on
 * every render — useRef(crypto.randomUUID()) would actually call
 * randomUUID() on every render (the argument is still evaluated each
 * time even though only the FIRST value is kept), so this uses the
 * `useRef<string>()` + assign-once-in-render pattern instead, which
 * avoids that subtlety while still only ever using the first value. A
 * fresh key is only generated if the user changes dates/guests after a
 * failed attempt — see resetIdempotencyKey below — matching "one stable
 * key per booking attempt," not one key forever regardless of what's
 * being booked.
 */

type Property = {
  id: string; name: string; slug: string | null; description: string | null;
  city: string; district: string | null; propertyType: string | null;
  currency: string; nightlyPrice: string | number; cleaningFee: string | number | null;
  maxGuests: number; bedrooms: number | null; bathrooms: number | null;
  checkInTime: string | null; checkOutTime: string | null; houseRules: string | null;
  rating: string | number | null; reviewCount: number | null;
  cancellationPolicy: { name: string; description: string | null; rules: unknown } | null;
  compliance: { reviewStatus: string; reviewedAt: string | null; reviewedCheckCount: number; statement: string };
};

type LoadState = "loading" | "notFound" | "error" | "loaded";
type BookingState = "idle" | "submitting" | "conflict" | "error";

export default function StayDetailPage({ params }: { params: Promise<{ slug: string }> }) {
  const { gt } = useGuestI18n();
  const [slug, setSlug] = useState<string | null>(null);
  const [property, setProperty] = useState<Property | null>(null);
  const [loadState, setLoadState] = useState<LoadState>("loading");

  const [checkIn, setCheckIn] = useState("");
  const [checkOut, setCheckOut] = useState("");
  const [guests, setGuests] = useState(1);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [bookingState, setBookingState] = useState<BookingState>("idle");
  const [bookingError, setBookingError] = useState<string | null>(null);
  const [guestName, setGuestName] = useState("");
  const [guestEmail, setGuestEmail] = useState("");
  const [unavailableDates, setUnavailableDates] = useState<Set<string>>(new Set());
  const [favouriteState, setFavouriteState] = useState(initialFavouriteState);

  const idempotencyKeyRef = useRef<string | undefined>(undefined);
  if (idempotencyKeyRef.current === undefined) idempotencyKeyRef.current = crypto.randomUUID();

  /**
   * FOUND during a real, exhaustive, live investigation into a reported
   * "cancelled booking still shows as booked on the calendar" defect:
   * the backend was proven correct at every layer — cancelBooking.ts
   * genuinely releases the dates (UPDATE ... SET status='available'),
   * the public availability endpoint immediately reflects this (real,
   * repeated live testing, including confirming its Cache-Control:
   * private, no-store header), and search correctly reflects it too.
   * By elimination against the exact categories investigated (stale
   * server cache, cancelled rows still included in the query,
   * cleanup inconsistency, or frontend state) — the only one left
   * standing is frontend state: this fetch previously ran exactly once,
   * on mount, with no mechanism to refresh if a guest cancels a booking
   * in another tab (e.g. via My Trips) and returns to an
   * already-open stay page rather than performing a fresh navigation.
   * Re-fetching when the tab regains visibility is the standard,
   * principled way to handle exactly this class of staleness — not a
   * guess, since every other layer was directly, repeatedly verified
   * correct first.
   */
  const fetchAvailability = (s: string) => {
    fetch(`/api/properties/${s}/availability`)
      .then((res) => res.json())
      .then((data) => { if (data.success) setUnavailableDates(new Set(data.unavailableDates)); })
      .catch(() => {});
  };

  useEffect(() => {
    params.then(({ slug: s }) => setSlug(s));
  }, [params]);

  useEffect(() => {
    if (!slug) return;
    // Initialise dates/guests from the URL if the visitor arrived from
    // /search — preserving the search context, per the batch brief.
    const urlParams = new URLSearchParams(window.location.search);
    if (urlParams.get("checkIn")) setCheckIn(urlParams.get("checkIn")!);
    if (urlParams.get("checkOut")) setCheckOut(urlParams.get("checkOut")!);
    if (urlParams.get("guests")) setGuests(Number(urlParams.get("guests")));

    fetch(`/api/properties/${slug}`)
      .then(async (res) => {
        const body = await res.json().catch(() => ({ success: false }));
        const result = interpretPropertyResponse(res.status, body);
        if (result.state === "loaded") {
          setProperty(result.property as unknown as Property);
          setLoadState("loaded");
        } else {
          setLoadState(result.state);
        }
      })
      .catch(() => setLoadState("error"));

    fetchAvailability(slug);
  }, [slug]);

  // Once the property has loaded, determine whether it's already
  // saved. A 401 here means the visitor is simply signed out — this is
  // NOT a failure to redirect for; it resolves to a normal, browsable
  // "unsaved" state so an anonymous visitor can keep browsing
  // undisturbed. Only an ACTIVE save/unsave attempt that itself
  // returns 401 (in handleToggleFavourite below) sends the visitor to
  // sign in.
  useEffect(() => {
    if (!property) return;
    const propertyId = property.id;
    fetch("/api/favourites", { credentials: "include", cache: "no-store" })
      .then(async (res) => {
        const body = await res.json().catch(() => null);
        const result = interpretFavouritesLoad(res.status, body, propertyId);
        if (result.kind === "signedOut") {
          setFavouriteState({ status: "unsaved", busy: false, error: null });
          return;
        }
        if (result.kind === "determined") {
          setFavouriteState({ status: result.saved ? "saved" : "unsaved", busy: false, error: null });
        }
        // A genuine "error" (a malformed response, a non-401 failure)
        // intentionally leaves favouriteState at its initial "unknown"
        // status rather than guessing — the control stays disabled
        // until a real answer is known.
      })
      .catch(() => {
        // Network failure loading the initial state — same reasoning:
        // stay "unknown" rather than guess.
      });
  }, [property?.id]);

  useEffect(() => {
    if (!slug) return;
    const handleVisibility = () => {
      if (document.visibilityState === "visible") fetchAvailability(slug);
    };
    document.addEventListener("visibilitychange", handleVisibility);
    return () => document.removeEventListener("visibilitychange", handleVisibility);
  }, [slug]);

  const resetIdempotencyKey = () => { idempotencyKeyRef.current = crypto.randomUUID(); };

  const handleToggleFavourite = async () => {
    if (!property) return;
    if (favouriteState.busy) return; // the button is also disabled while busy; this is the belt-and-braces guard against a race
    const wantsSaved = favouriteState.status !== "saved";
    setFavouriteState((prev) => beginFavouriteAction(prev));
    try {
      const res = wantsSaved
        ? await fetch("/api/favourites", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            credentials: "include",
            body: JSON.stringify({ propertyId: property.id }),
          })
        : await fetch(`/api/favourites/${property.id}`, { method: "DELETE", credentials: "include" });

      const body = await res.json().catch(() => null);
      const result = interpretFavouriteMutation(res.status, body, gt("saveUpdateError"));

      if (result.kind === "unauthorized") {
        // Only an ACTIVE save/unsave attempt redirects — the initial,
        // passive load never does (see the favourites-load effect
        // above). Does not auto-save after login; the guest lands back
        // on this same page and must press Save again themselves.
        const returnTo = buildLoginRedirectUrl(window.location.pathname, window.location.search);
        window.location.href = returnTo;
        return;
      }
      setFavouriteState((prev) => completeFavouriteAction(prev, result, wantsSaved));
    } catch {
      setFavouriteState((prev) => completeFavouriteAction(prev, { kind: "error", message: gt("saveUpdateError") }, wantsSaved));
    }
  };

  const handleReserve = async () => {
    setValidationError(null);
    setBookingError(null);

    if (!property) return;
    const validationMessage = validateBookingForm({ checkIn, checkOut, guests, maxGuests: property.maxGuests, guestName, guestEmail });
    if (validationMessage) { setValidationError(validationMessage); return; }

    setBookingState("submitting");
    try {
      const res = await fetch("/api/bookings", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": idempotencyKeyRef.current! },
        credentials: "include",
        body: JSON.stringify({
          propertyId: property.id,
          checkIn,
          checkOut,
          guests,
          // Real name/email are required by the existing schema — this
          // page doesn't yet have a dedicated guest-details step, so it
          // asks for them inline right before submitting rather than
          // inventing placeholder values, which the backend would
          // otherwise happily (and wrongly) accept.
          guestName, guestEmail,
        }),
      });

      if (res.status === 401) {
        // Preserve the intended booking — property, dates, guests — and
        // send the user to sign in, returning them here afterward. Does
        // NOT auto-submit the booking on return; the user sees the same
        // pre-filled property page and presses Reserve again, which is a
        // safer, clearer pattern than silently booking on their behalf
        // the moment they land back.
        const returnTo = `${window.location.pathname}?checkIn=${checkIn}&checkOut=${checkOut}&guests=${guests}`;
        window.location.href = `/login?returnTo=${encodeURIComponent(returnTo)}`;
        return;
      }

      const data = await res.json();
      if (!data.success) {
        if (data.error?.code === "DATES_UNAVAILABLE") {
          setBookingState("conflict");
          setBookingError(gt("datesBooked"));
        } else {
          setBookingState("error");
          setBookingError(data.error?.message ?? gt("createBookingError"));
        }
        resetIdempotencyKey(); // a genuinely failed attempt gets a fresh key for the next real try
        return;
      }

      window.location.href = `/checkout/${data.booking.id}`;
    } catch {
      setBookingState("error");
      setBookingError(gt("reachingServerError"));
      resetIdempotencyKey();
    }
  };

  // Standard two-click range selection: first click sets check-in and
  // clears check-out; a second click after a valid check-in sets
  // check-out (if after it); any other click restarts the selection.
  // The calendar itself already refuses to even offer a click on a
  // disabled date (past or unavailable) — see AvailabilityCalendar's
  // own `clickable` guard — so this handler only ever receives dates
  // that were genuinely selectable at render time.
  const handleCalendarSelect = (iso: string) => {
    if (!checkIn || (checkIn && checkOut)) {
      setCheckIn(iso);
      setCheckOut("");
    } else if (iso > checkIn) {
      setCheckOut(iso);
    } else {
      setCheckIn(iso);
      setCheckOut("");
    }
  };

  // Informational estimate only, built entirely from the property's own
  // already-fetched authoritative unit price/fee — not a second pricing
  // engine. The real, authoritative total is always computed server-side
  // at booking creation (lib/booking/priceEngine.ts), which this number
  // never substitutes for — see the disclaimer text right below it.
  const previewNights = checkIn && checkOut ? Math.round((new Date(checkOut).getTime() - new Date(checkIn).getTime()) / 86400000) : null;
  const previewSubtotal = previewNights != null && property ? previewNights * Number(property.nightlyPrice) : null;
  const previewTotal = previewSubtotal != null && property ? previewSubtotal + Number(property.cleaningFee ?? 0) : null;

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
        .state-block { max-width: 720px; margin: 80px auto; padding: 0 28px; text-align: center; color: var(--warm-grey); }
        .error-box { background: rgba(224,121,107,0.12); border: 1px solid var(--error); color: var(--error); padding: 14px 18px; border-radius: 6px; display: inline-block; }

        .hero-tile { height: 280px; background: linear-gradient(135deg, var(--stone) 0%, var(--ink) 100%); position: relative; }
        .hero-tile::after { content: ""; position: absolute; inset: 0; background: linear-gradient(180deg, transparent 40%, rgba(201,151,75,0.12) 100%); }

        .layout { max-width: 1080px; margin: 0 auto; padding: 40px 28px 100px; display: grid; grid-template-columns: 1.7fr 1fr; gap: 48px; }
        @media (max-width: 860px) { .layout { grid-template-columns: 1fr; } }

        .eyebrow { font-size: 11px; letter-spacing: 0.12em; text-transform: uppercase; color: var(--brass); margin-bottom: 8px; }
        h1 { font-size: 32px; font-weight: 400; margin-bottom: 10px; }
        .location-line { color: var(--warm-grey); font-size: 15px; margin-bottom: 6px; }
        .rating-line { font-size: 13px; color: var(--warm-grey); margin-bottom: 28px; }
        .heading-row { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; }
        .save-btn {
          display: inline-flex; align-items: center; gap: 7px; flex-shrink: 0;
          background: transparent; border: 1px solid var(--stone); color: var(--ivory);
          padding: 8px 14px; border-radius: 20px; font-family: var(--font-body); font-size: 13px;
          cursor: pointer; margin-top: 4px;
        }
        .save-btn:hover:not(:disabled) { border-color: var(--brass); }
        .save-btn:disabled { opacity: 0.6; cursor: wait; }
        .save-btn.is-saved { border-color: var(--brass); color: var(--brass); }
        .save-btn .heart-icon { flex-shrink: 0; }
        .save-btn.is-saved .heart-icon { color: var(--brass); }
        .meta-row { display: flex; gap: 20px; font-size: 14px; color: var(--warm-grey); margin-bottom: 32px; padding-bottom: 24px; border-bottom: 1px solid var(--stone); }

        section.detail-section { margin-bottom: 32px; }
        section.detail-section h2 { font-size: 18px; font-weight: 400; margin-bottom: 10px; }
        section.detail-section p { color: var(--warm-grey); font-size: 14px; line-height: 1.7; white-space: pre-wrap; }
        .policy-box { background: var(--graphite); border: 1px solid var(--stone); border-radius: 6px; padding: 16px 18px; }
        .policy-box .policy-name { font-family: var(--font-display), Georgia, serif; font-size: 15px; margin-bottom: 6px; }

        .booking-panel { position: sticky; top: 24px; align-self: start; background: var(--graphite); border: 1px solid var(--stone); border-radius: 8px; padding: 22px; }
        .booking-price { font-family: var(--font-display), Georgia, serif; font-size: 24px; margin-bottom: 4px; }
        .booking-price .unit { font-size: 13px; color: var(--warm-grey); font-family: var(--font-body); }
        .booking-fields { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin: 18px 0 12px; }
        .booking-field { grid-column: span 1; }
        .booking-field.full { grid-column: 1 / -1; }
        .booking-field label { display: block; font-size: 10px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--warm-grey); margin-bottom: 6px; }
        .booking-field input { width: 100%; background: var(--ink); border: 1px solid var(--stone); color: var(--ivory); padding: 10px 11px; border-radius: 4px; font-family: var(--font-body); font-size: 14px; color-scheme: dark; }
        .booking-field input:focus { outline: none; border-color: var(--brass); }
        .date-display { background: var(--ink); border: 1px solid var(--stone); border-radius: 4px; padding: 10px 11px; font-size: 14px; color: var(--ivory); }
        .price-summary { border-top: 1px solid var(--stone); margin-top: 16px; padding-top: 14px; }
        .price-row { display: flex; justify-content: space-between; font-size: 13px; color: var(--warm-grey); padding: 4px 0; }
        .price-row.price-total { font-family: var(--font-display), Georgia, serif; font-size: 16px; color: var(--ivory); border-top: 1px solid var(--stone); margin-top: 6px; padding-top: 10px; }
        .btn-primary { width: 100%; background: var(--brass); color: var(--ink); border: none; padding: 13px 20px; border-radius: 4px; font-family: var(--font-body); font-size: 14px; font-weight: 500; cursor: pointer; margin-top: 8px; }
        .btn-primary:disabled { opacity: 0.6; cursor: wait; }
        .field-error { font-size: 12px; color: var(--error); margin-top: 6px; }
        .booking-note { font-size: 12px; color: var(--warm-grey); margin-top: 12px; line-height: 1.6; }
      `}</style>

      <CustomerNav />
      <div className="top-link"><a href="/search">← {gt("backSearch")}</a></div>

      {loadState === "loading" && <div className="state-block">{gt("loadingStay")}</div>}

      {loadState === "notFound" && (
        <div className="state-block">
          <h1 className="display">{gt("stayNotFound")}</h1>
          <p>{gt("mayUnavailable")}</p>
        </div>
      )}

      {loadState === "error" && (
        <div className="state-block"><div className="error-box">{gt("loadStayError")}</div></div>
      )}

      {loadState === "loaded" && property && (
        <>
          <div className="hero-tile" />
          <div className="layout">
            <div>
              <div className="heading-row">
                <div>
                  <div className="eyebrow">{property.propertyType ?? gt("stay")}</div>
                  <h1 className="display">{property.name}</h1>
                </div>
                <button
                  type="button"
                  className={`save-btn${favouriteState.status === "saved" ? " is-saved" : ""}`}
                  onClick={handleToggleFavourite}
                  disabled={favouriteState.busy || favouriteState.status === "unknown"}
                  aria-pressed={favouriteState.status === "saved"}
                  aria-label={favouriteState.status === "saved" ? gt("removeSavedStay") : gt("saveThisStay")}
                >
                  <svg className="heart-icon" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
                    <path
                      d="M12 21s-6.7-4.35-9.33-8.19C.59 9.94 1.15 6.6 3.64 5.1 5.6 3.92 8 4.5 9.5 6.5L12 9.5l2.5-3C16 4.5 18.4 3.92 20.36 5.1c2.49 1.5 3.05 4.84 1 7.71C18.7 16.65 12 21 12 21z"
                      fill={favouriteState.status === "saved" ? "currentColor" : "none"}
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinejoin="round"
                    />
                  </svg>
                  {favouriteState.busy ? gt("saving") : (favouriteState.status === "saved" ? gt("saved") : gt("save"))}
                </button>
              </div>
              {favouriteState.error && (
                <div className="field-error" role="alert">{favouriteState.error}</div>
              )}
              <div className="location-line">{[property.district, property.city].filter(Boolean).join(", ")}</div>
              {property.rating != null && property.reviewCount != null && (
                <div className="rating-line">★ {Number(property.rating).toFixed(1)} ({property.reviewCount} {Number(property.reviewCount) === 1 ? gt("oneReview") : gt("manyReviews")})</div>
              )}

              <div className="meta-row">
                <span>{property.maxGuests} {Number(property.maxGuests) === 1 ? gt("guest") : gt("guests")}</span>
                {property.bedrooms != null && <span>{property.bedrooms} {Number(property.bedrooms) === 1 ? gt("bedroom") : gt("bedrooms")}</span>}
                {property.bathrooms != null && <span>{property.bathrooms} {Number(property.bathrooms) === 1 ? gt("bathroom") : gt("bathrooms")}</span>}
              </div>

              {property.description && (
                <section className="detail-section">
                  <h2 className="display">{gt("aboutStay")}</h2>
                  <p>{property.description}</p>
                </section>
              )}

              {(property.checkInTime || property.checkOutTime) && (
                <section className="detail-section">
                  <h2 className="display">{gt("checkInOut")}</h2>
                  <p>
                    {property.checkInTime && `${gt("checkInFrom")} ${formatTime(property.checkInTime)}`}
                    {property.checkInTime && property.checkOutTime && " · "}
                    {property.checkOutTime && `${gt("checkOutBy")} ${formatTime(property.checkOutTime)}`}
                  </p>
                </section>
              )}

              {property.houseRules && (
                <section className="detail-section">
                  <h2 className="display">{gt("houseRules")}</h2>
                  <p>{property.houseRules}</p>
                </section>
              )}

              <section className="detail-section">
                <h2 className="display">{gt("propertyCompliance")}</h2>
                <div className="policy-box">
                  <div className="policy-name">{property.compliance.reviewStatus === "evidence_reviewed" ? gt("ownerEvidenceReviewed") : gt("reviewPending")}</div>
                  <p style={{ marginTop: 0 }}>{property.compliance.reviewStatus === "evidence_reviewed" ? gt("complianceReviewed") : gt("compliancePending")}</p>
                  {property.compliance.reviewedAt && <p style={{ marginBottom: 0, fontSize: 12 }}>{gt("lastReviewed")} {new Date(property.compliance.reviewedAt).toLocaleDateString()} · {property.compliance.reviewedCheckCount} {gt("applicableChecks")}</p>}
                </div>
              </section>

              {property.cancellationPolicy && (
                <section className="detail-section">
                  <h2 className="display">{gt("cancellationPolicy")}</h2>
                  <div className="policy-box">
                    <div className="policy-name">{property.cancellationPolicy.name}</div>
                    {property.cancellationPolicy.description && <p style={{ marginTop: 0 }}>{property.cancellationPolicy.description}</p>}
                  </div>
                </section>
              )}

              <PropertyReviews
                propertyId={property.id}
                rating={property.rating != null ? Number(property.rating) : null}
                reviewCount={property.reviewCount}
              />
            </div>

            <div className="booking-panel">
              <div className="booking-price">
                {property.currency} {Number(property.nightlyPrice).toFixed(0)} <span className="unit">/ {gt("night")}</span>
              </div>
              <div style={{ fontSize: 12, color: "var(--warm-grey)" }}>
                {gt("informationalPrice")}
              </div>

              <AvailabilityCalendar
                disabledDates={unavailableDates}
                checkIn={checkIn}
                checkOut={checkOut}
                onSelectDate={handleCalendarSelect}
              />

              <div className="booking-fields" style={{ marginTop: 14 }}>
                <div className="booking-field">
                  <label>{gt("checkIn")}</label>
                  <div className="date-display">{checkIn || gt("selectDate")}</div>
                </div>
                <div className="booking-field">
                  <label>{gt("checkOut")}</label>
                  <div className="date-display">{checkOut || gt("selectDate")}</div>
                </div>
                <div className="booking-field full">
                  <label htmlFor="guests">{gt("guests")}</label>
                  <input id="guests" type="number" min={1} max={property.maxGuests} value={guests} onChange={(e) => setGuests(Math.max(1, Number(e.target.value) || 1))} />
                </div>
                <div className="booking-field full">
                  <label htmlFor="guestName">{gt("fullName")}</label>
                  <input id="guestName" type="text" value={guestName} onChange={(e) => setGuestName(e.target.value)} />
                </div>
                <div className="booking-field full">
                  <label htmlFor="guestEmail">{gt("email")}</label>
                  <input id="guestEmail" type="email" value={guestEmail} onChange={(e) => setGuestEmail(e.target.value)} />
                </div>
              </div>

              {previewNights != null && previewTotal != null && property && (
                <div className="price-summary">
                  <div className="price-row"><span>{property.currency} {Number(property.nightlyPrice).toFixed(0)} × {previewNights} {gt("night")}</span><span>{formatCurrency(previewSubtotal! * 100, property.currency)}</span></div>
                  {Number(property.cleaningFee ?? 0) > 0 && (
                    <div className="price-row"><span>{gt("cleaningFee")}</span><span>{formatCurrency(Number(property.cleaningFee) * 100, property.currency)}</span></div>
                  )}
                  <div className="price-row price-total"><span>{gt("estimatedTotal")}</span><span>{formatCurrency(previewTotal * 100, property.currency)}</span></div>
                </div>
              )}

              {validationError && <div className="field-error">{validationError}</div>}
              {(bookingState === "conflict" || bookingState === "error") && bookingError && <div className="field-error">{bookingError}</div>}

              <button className="btn-primary" onClick={handleReserve} disabled={bookingState === "submitting"}>
                {bookingState === "submitting" ? gt("reserving") : gt("reserve")}
              </button>

              <div className="booking-note">
                {gt("notChargedYet")}
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
