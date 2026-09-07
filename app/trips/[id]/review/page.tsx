"use client";

import { useEffect, useState } from "react";
import { formatDate } from "@/lib/presentation/formatters";

type BookingContext = { id: string; propertyName: string; status: string; checkIn: string; checkOut: string };
type ExistingReview = {
  id: string; overall: number; cleanliness: number | null; locationRating: number | null;
  accuracy: number | null; communication: number | null; comfort: number | null;
  body: string | null; hostReply: string | null; hostReplyAt: string | null; createdAt: string;
};

const SUB_RATINGS: { key: "cleanliness" | "location" | "accuracy" | "communication" | "comfort"; label: string }[] = [
  { key: "cleanliness", label: "Cleanliness" },
  { key: "location", label: "Location" },
  { key: "accuracy", label: "Accuracy" },
  { key: "communication", label: "Communication" },
  { key: "comfort", label: "Comfort" },
];

function StarInput({ value, onChange, label }: { value: number; onChange: (n: number) => void; label: string }) {
  return (
    <div className="star-row">
      <span className="star-label">{label}</span>
      <div className="stars" role="radiogroup" aria-label={label}>
        {[1, 2, 3, 4, 5].map((n) => (
          <button
            key={n}
            type="button"
            role="radio"
            aria-checked={value === n}
            aria-label={`${n} star${n === 1 ? "" : "s"}`}
            className={`star ${n <= value ? "filled" : ""}`}
            onClick={() => onChange(n)}
          >★</button>
        ))}
      </div>
    </div>
  );
}

export default function ReviewPage({ params }: { params: Promise<{ id: string }> }) {
  const [bookingId, setBookingId] = useState<string | null>(null);
  const [booking, setBooking] = useState<BookingContext | null>(null);
  const [existingReview, setExistingReview] = useState<ExistingReview | null>(null);
  const [state, setState] = useState<"loading" | "unauthenticated" | "not-completed" | "ready" | "submitted" | "error" | "forbidden">("loading");

  const [overall, setOverall] = useState(0);
  const [subRatings, setSubRatings] = useState<Record<string, number>>({});
  const [body, setBody] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  useEffect(() => { params.then(({ id }) => setBookingId(id)); }, [params]);

  useEffect(() => {
    if (!bookingId) return;
    fetch(`/api/bookings/${bookingId}`, { credentials: "include" })
      .then(async (res) => {
        if (res.status === 401) { setState("unauthenticated"); return; }
        if (res.status === 403) { setState("forbidden"); return; }
        const data = await res.json();
        if (!data.success) { setState("error"); return; }
        setBooking(data.booking);

        // A guest may only reach the write experience once the stay is
        // genuinely completed (see lib/reviews/createReview.ts's own
        // guard) — reflected here so the page never even attempts a
        // request that would be rejected server-side.
        if (data.booking.status !== "completed") { setState("not-completed"); return; }

        const reviewRes = await fetch(`/api/bookings/${bookingId}/review`, { credentials: "include" });
        const reviewData = await reviewRes.json();
        if (reviewData.success && reviewData.review) {
          setExistingReview({
            id: reviewData.review.id, overall: reviewData.review.overall,
            cleanliness: reviewData.review.cleanliness, locationRating: reviewData.review.location_rating,
            accuracy: reviewData.review.accuracy, communication: reviewData.review.communication, comfort: reviewData.review.comfort,
            body: reviewData.review.body, hostReply: reviewData.review.host_reply, hostReplyAt: reviewData.review.host_reply_at,
            createdAt: reviewData.review.created_at,
          });
          setState("submitted");
        } else {
          setState("ready");
        }
      })
      .catch(() => setState("error"));
  }, [bookingId]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitError(null);
    if (overall < 1) { setSubmitError("Please choose an overall rating."); return; }

    setSubmitting(true);
    try {
      const res = await fetch("/api/reviews", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          bookingId, overall,
          cleanliness: subRatings.cleanliness || undefined, location: subRatings.location || undefined,
          accuracy: subRatings.accuracy || undefined, communication: subRatings.communication || undefined, comfort: subRatings.comfort || undefined,
          body: body.trim() || undefined,
        }),
      });
      const data = await res.json();
      if (!data.success) {
        setSubmitError(data.error?.message ?? "Couldn't submit your review. Please try again.");
        setSubmitting(false);
        return;
      }
      setExistingReview({
        id: data.review.id, overall: data.review.overall, cleanliness: data.review.cleanliness,
        locationRating: data.review.location_rating, accuracy: data.review.accuracy,
        communication: data.review.communication, comfort: data.review.comfort,
        body: data.review.body, hostReply: null, hostReplyAt: null, createdAt: data.review.created_at,
      });
      setState("submitted");
      setSubmitting(false);
    } catch {
      setSubmitError("Something went wrong reaching the server. Please try again.");
      setSubmitting(false);
    }
  };

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
        .header { max-width: 560px; margin: 0 auto; padding: 8px 28px 20px; }
        .header h1 { font-size: 24px; font-weight: 400; }
        .header p { color: var(--warm-grey); font-size: 13px; margin-top: 4px; }
        .state-block { max-width: 560px; margin: 60px auto; padding: 0 28px; text-align: center; color: var(--warm-grey); }
        .btn-primary { background: var(--brass); color: var(--ink); border: none; padding: 12px 22px; border-radius: 4px; font-family: var(--font-body); font-size: 14px; font-weight: 500; cursor: pointer; text-decoration: none; display: inline-block; margin-top: 16px; }
        .btn-primary:disabled { opacity: 0.6; cursor: wait; }
        .wrap { max-width: 560px; margin: 0 auto; padding: 0 28px 80px; }
        .card { background: var(--graphite); border: 1px solid var(--stone); border-radius: 8px; padding: 22px; margin-bottom: 20px; }
        .star-row { display: flex; justify-content: space-between; align-items: center; padding: 8px 0; }
        .star-label { font-size: 13px; color: var(--ivory); }
        .stars { display: flex; gap: 2px; }
        .star { background: none; border: none; font-size: 22px; color: var(--stone); cursor: pointer; padding: 2px; line-height: 1; }
        .star.filled { color: var(--brass); }
        .star:focus-visible { outline: 2px solid var(--brass); outline-offset: 2px; border-radius: 3px; }
        .overall-row { padding-bottom: 16px; margin-bottom: 12px; border-bottom: 1px solid var(--stone); }
        .overall-row .star { font-size: 30px; }
        label.field-label { display: block; font-size: 11px; letter-spacing: 0.05em; text-transform: uppercase; color: var(--warm-grey); margin: 16px 0 6px; }
        textarea { width: 100%; background: var(--ink); border: 1px solid var(--stone); color: var(--ivory); padding: 10px 12px; border-radius: 4px; font-family: var(--font-body); font-size: 14px; min-height: 100px; resize: vertical; }
        textarea:focus { outline: none; border-color: var(--brass); }
        .error-box { background: rgba(224,121,107,0.12); border: 1px solid var(--error); color: var(--error); padding: 10px 14px; border-radius: 4px; margin-bottom: 16px; font-size: 13px; }
        .submitted-stars { display: flex; gap: 2px; margin-bottom: 4px; }
        .submitted-stars .star { font-size: 18px; cursor: default; }
        .review-body { font-size: 14px; line-height: 1.6; margin: 12px 0; }
        .reply-block { background: var(--ink); border: 1px solid var(--stone); border-radius: 6px; padding: 14px; margin-top: 16px; }
        .reply-block .label { font-size: 11px; color: var(--brass); text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 6px; }
        .sub-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 4px 16px; margin-top: 8px; }
        .sub-item { font-size: 12px; color: var(--warm-grey); display: flex; justify-content: space-between; }
      `}</style>

      <div className="top-link"><a href={bookingId ? `/trips/${bookingId}` : "/trips"}>← Back to trip</a></div>

      {state === "loading" && <div className="state-block">Loading…</div>}
      {state === "unauthenticated" && (
        <div className="state-block">
          <p style={{ marginBottom: 16 }}>Sign in to leave a review.</p>
          <a href={`/login?returnTo=${encodeURIComponent(`/trips/${bookingId ?? ""}/review`)}`} className="btn-primary">Sign in</a>
        </div>
      )}
      {state === "forbidden" && <div className="state-block">This trip isn't available.</div>}
      {state === "error" && <div className="state-block">Something went wrong. Please try again shortly.</div>}
      {state === "not-completed" && (
        <div className="state-block">Reviews open up once your stay is complete. Check back after checkout.</div>
      )}

      {(state === "ready" || state === "submitted") && booking && (
        <>
          <div className="header">
            <h1 className="display">{state === "submitted" ? "Your review" : "How was your stay?"}</h1>
            <p>{booking.propertyName} · {formatDate(booking.checkIn)} – {formatDate(booking.checkOut)}</p>
          </div>

          <div className="wrap">
            {state === "ready" && (
              <form className="card" onSubmit={handleSubmit}>
                {submitError && <div className="error-box">{submitError}</div>}
                <div className="overall-row">
                  <StarInput value={overall} onChange={setOverall} label="Overall rating" />
                </div>
                {SUB_RATINGS.map(({ key, label }) => (
                  <StarInput key={key} value={subRatings[key] ?? 0} onChange={(n) => setSubRatings((p) => ({ ...p, [key]: n }))} label={label} />
                ))}
                <label className="field-label" htmlFor="reviewBody">Tell other guests about your stay (optional)</label>
                <textarea id="reviewBody" value={body} onChange={(e) => setBody(e.target.value)} maxLength={3000} />
                <button type="submit" className="btn-primary" disabled={submitting}>{submitting ? "Submitting…" : "Submit review"}</button>
              </form>
            )}

            {state === "submitted" && existingReview && (
              <div className="card">
                <div className="submitted-stars">{[1, 2, 3, 4, 5].map((n) => <span key={n} className={`star ${n <= existingReview.overall ? "filled" : ""}`}>★</span>)}</div>
                <p style={{ fontSize: 12, color: "var(--warm-grey)" }}>Submitted {formatDate(existingReview.createdAt)}</p>
                {existingReview.body && <p className="review-body">{existingReview.body}</p>}
                <div className="sub-grid">
                  {SUB_RATINGS.map(({ key, label }) => {
                    const value = key === "location" ? existingReview.locationRating : (existingReview as any)[key];
                    if (!value) return null;
                    return <div className="sub-item" key={key}><span>{label}</span><span>{value}/5</span></div>;
                  })}
                </div>
                {existingReview.hostReply && (
                  <div className="reply-block">
                    <div className="label">Host response</div>
                    <p style={{ fontSize: 13 }}>{existingReview.hostReply}</p>
                    {existingReview.hostReplyAt && <p style={{ fontSize: 11, color: "var(--warm-grey)", marginTop: 6 }}>{formatDate(existingReview.hostReplyAt)}</p>}
                  </div>
                )}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
