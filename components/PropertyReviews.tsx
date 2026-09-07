"use client";

import { useEffect, useState } from "react";
import { formatDate } from "@/lib/presentation/formatters";
import { useGuestI18n } from "@/lib/i18n/useGuestI18n";

type Review = {
  id: string; overall: number; cleanliness: number | null; location_rating: number | null;
  accuracy: number | null; communication: number | null; comfort: number | null;
  body: string | null; host_reply: string | null; host_reply_at: string | null; created_at: string;
};

const INITIAL_COUNT = 5;

export function PropertyReviews({ propertyId, rating, reviewCount }: { propertyId: string; rating: number | null; reviewCount: number | null }) {
  const { gt } = useGuestI18n();
  const [reviews, setReviews] = useState<Review[]>([]);
  const [state, setState] = useState<"loading" | "loaded" | "error">("loading");
  const [visibleCount, setVisibleCount] = useState(INITIAL_COUNT);

  useEffect(() => {
    fetch(`/api/properties/${propertyId}/reviews`)
      .then(async (res) => {
        const data = await res.json();
        if (!data.success) { setState("error"); return; }
        setReviews(data.reviews);
        setState("loaded");
      })
      .catch(() => setState("error"));
  }, [propertyId]);

  // Averages computed client-side, purely for the sub-rating breakdown
  // display — this is NOT a second aggregate-rating engine: the overall
  // rating/count shown at the top of this section always come straight
  // from the property's own already-authoritative rating/reviewCount
  // fields (recalculated server-side in lib/reviews/createReview.ts),
  // never recomputed here.
  const subLabels: { key: keyof Review; label: string }[] = [
    { key: "cleanliness", label: gt("cleanliness") }, { key: "location_rating", label: gt("location") },
    { key: "accuracy", label: gt("accuracy") }, { key: "communication", label: gt("communication") }, { key: "comfort", label: gt("comfort") },
  ];
  const subAverages = subLabels.map(({ key, label }) => {
    const values = reviews.map((r) => r[key]).filter((v): v is number => v != null);
    if (values.length === 0) return null;
    const avg = values.reduce((a, b) => a + b, 0) / values.length;
    return { label, avg };
  }).filter((v): v is { label: string; avg: number } => v !== null);

  return (
    <section className="detail-section reviews-section">
      <style>{`
        .reviews-section .reviews-header { display: flex; align-items: baseline; gap: 10px; margin-bottom: 4px; }
        .reviews-section .agg-score { font-family: var(--font-display), Georgia, serif; font-size: 20px; }
        .reviews-section .agg-count { font-size: 13px; color: var(--warm-grey); }
        .reviews-section .sub-breakdown { display: grid; grid-template-columns: repeat(auto-fit, minmax(130px, 1fr)); gap: 6px 20px; margin: 16px 0 22px; padding: 14px; background: var(--graphite); border: 1px solid var(--stone); border-radius: 6px; }
        .reviews-section .sub-breakdown .item { font-size: 12px; color: var(--warm-grey); display: flex; justify-content: space-between; }
        .review-card { border-top: 1px solid var(--stone); padding: 16px 0; }
        .review-card:first-of-type { border-top: none; padding-top: 0; }
        .review-card .stars { color: var(--brass); font-size: 13px; margin-bottom: 4px; }
        .review-card .date { font-size: 12px; color: var(--warm-grey); margin-bottom: 8px; }
        .review-card .body-text { font-size: 14px; line-height: 1.6; }
        .review-card .reviewer { font-size: 12px; color: var(--warm-grey); font-weight: 500; margin-bottom: 2px; }
        .review-card .reply { background: var(--graphite); border: 1px solid var(--stone); border-radius: 6px; padding: 12px 14px; margin-top: 12px; }
        .review-card .reply .label { font-size: 11px; color: var(--brass); text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 4px; }
        .reviews-empty { color: var(--warm-grey); font-size: 13px; }
        .show-more-btn { background: transparent; border: 1px solid var(--stone); color: var(--ivory); padding: 9px 16px; border-radius: 4px; font-family: var(--font-body); font-size: 13px; cursor: pointer; margin-top: 8px; }
      `}</style>

      <h2 className="display">{gt("reviewsHeading")}</h2>

      {rating != null && reviewCount != null && reviewCount > 0 && (
        <div className="reviews-header">
          <span className="agg-score">★ {Number(rating).toFixed(1)}</span>
          <span className="agg-count">{reviewCount} {reviewCount === 1 ? gt("oneReview") : gt("manyReviews")}</span>
        </div>
      )}

      {state === "loading" && <p className="reviews-empty">{gt("loadingReviews")}</p>}
      {state === "error" && <p className="reviews-empty">{gt("loadReviewsError")}</p>}

      {state === "loaded" && reviews.length === 0 && (
        <p className="reviews-empty">{gt("noReviews")}</p>
      )}

      {state === "loaded" && reviews.length > 0 && (
        <>
          {subAverages.length > 0 && (
            <div className="sub-breakdown">
              {subAverages.map(({ label, avg }) => (
                <div className="item" key={label}><span>{label}</span><span>{avg.toFixed(1)}/5</span></div>
              ))}
            </div>
          )}

          {reviews.slice(0, visibleCount).map((r) => (
            <div className="review-card" key={r.id}>
              {/* Deliberately no reviewer name or any identifying detail —
                  matches the backend's own design: listPropertyReviews()
                  never selects a guest-identifying field at all, so
                  there is nothing here to leak. */}
              <div className="reviewer">{gt("reviewerGuest")}</div>
              <div className="stars">{"★".repeat(r.overall)}{"☆".repeat(5 - r.overall)}</div>
              <div className="date">{formatDate(r.created_at)}</div>
              {r.body && <p className="body-text">{r.body}</p>}
              {r.host_reply && (
                <div className="reply">
                  <div className="label">{gt("hostResponse")}</div>
                  <p style={{ fontSize: 13, margin: 0 }}>{r.host_reply}</p>
                  {r.host_reply_at && <p style={{ fontSize: 11, color: "var(--warm-grey)", marginTop: 6, marginBottom: 0 }}>{formatDate(r.host_reply_at)}</p>}
                </div>
              )}
            </div>
          ))}

          {visibleCount < reviews.length && (
            <button className="show-more-btn" onClick={() => setVisibleCount((c) => c + 10)}>
              {gt("showMoreReviews")} ({reviews.length - visibleCount})
            </button>
          )}
        </>
      )}
    </section>
  );
}
