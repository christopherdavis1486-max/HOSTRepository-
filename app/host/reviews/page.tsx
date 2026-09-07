"use client";

import { useEffect, useMemo, useState } from "react";
import { HostNav } from "@/components/HostNav";
import { useHostI18n } from "@/lib/i18n/useHostI18n";

type Review = {
  id: string; property_id: string; property_name: string;
  overall: number; cleanliness: number | null; location_rating: number | null;
  accuracy: number | null; communication: number | null; comfort: number | null;
  body: string | null; host_reply: string | null; host_reply_at: string | null;
  status: string; created_at: string;
};

const SUB_LABELS: { key: keyof Review; label: string }[] = [
  { key: "cleanliness", label: "Cleanliness" },
  { key: "location_rating", label: "Location" },
  { key: "accuracy", label: "Accuracy" },
  { key: "communication", label: "Communication" },
  { key: "comfort", label: "Comfort" },
];

function ReplyForm({ review, onReplied }: { review: Review; onReplied: (reviewId: string, reply: string) => void }) {
  const { ht } = useHostI18n();
  const [draft, setDraft] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!draft.trim()) return;
    setSubmitting(true);
    try {
      const res = await fetch(`/api/reviews/${review.id}/reply`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ reply: draft.trim() }),
      });
      const data = await res.json();
      if (!data.success) {
        setError(data.error?.message ?? "Couldn't submit your reply.");
        setSubmitting(false);
        return;
      }
      onReplied(review.id, draft.trim());
    } catch {
      setError("Something went wrong reaching the server.");
      setSubmitting(false);
    }
  };

  return (
    <form className="reply-form" onSubmit={handleSubmit}>
      {error && <div className="reply-error">{error}</div>}
      <label className="field-label" htmlFor={`reply-${review.id}`}>{ht("Your reply")}</label>
      <textarea id={`reply-${review.id}`} aria-label={ht("Write a public reply…")} value={draft} onChange={(e) => setDraft(e.target.value)} maxLength={2000} />
      <button type="submit" className="btn-secondary" disabled={submitting || !draft.trim()}>{submitting ? ht("Posting…") : ht("Post reply")}</button>
    </form>
  );
}

export default function HostReviewsPage() {
  const { ht, hDate } = useHostI18n();
  const [reviews, setReviews] = useState<Review[]>([]);
  const [state, setState] = useState<"loading" | "unauthenticated" | "forbidden" | "loaded" | "error">("loading");
  const [propertyFilter, setPropertyFilter] = useState<string>("all");

  useEffect(() => {
    fetch("/api/host/reviews", { credentials: "include" })
      .then(async (res) => {
        if (res.status === 401) { setState("unauthenticated"); return; }
        if (res.status === 403) { setState("forbidden"); return; }
        const data = await res.json();
        if (!data.success) { setState("error"); return; }
        setReviews(data.reviews);
        setState("loaded");
      })
      .catch(() => setState("error"));
  }, []);

  const properties = useMemo(() => {
    const map = new Map<string, string>();
    reviews.forEach((r) => map.set(r.property_id, r.property_name));
    return Array.from(map.entries());
  }, [reviews]);

  const visibleReviews = reviews.filter((r) => {
    if (r.status !== "published") return false;
    if (propertyFilter !== "all" && r.property_id !== propertyFilter) return false;
    return true;
  });

  const handleReplied = (reviewId: string, reply: string) => {
    setReviews((prev) => prev.map((r) => (r.id === reviewId ? { ...r, host_reply: reply, host_reply_at: new Date().toISOString() } : r)));
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
        .header { max-width: 780px; margin: 0 auto; padding: 24px 28px 16px; }
        .header h1 { font-size: 24px; font-weight: 400; }
        .state-block { max-width: 780px; margin: 60px auto; padding: 0 28px; text-align: center; color: var(--warm-grey); }
        .btn-primary { background: var(--brass); color: var(--ink); border: none; padding: 12px 22px; border-radius: 4px; font-family: var(--font-body); font-size: 14px; font-weight: 500; cursor: pointer; text-decoration: none; display: inline-block; margin-top: 16px; }
        .wrap { max-width: 780px; margin: 0 auto; padding: 16px 28px 80px; }
        .filter-row { display: flex; gap: 8px; margin-bottom: 20px; flex-wrap: wrap; }
        .filter-btn { background: transparent; border: 1px solid var(--stone); color: var(--warm-grey); padding: 7px 14px; border-radius: 4px; font-size: 12px; cursor: pointer; }
        .filter-btn.active { border-color: var(--brass); color: var(--brass); }
        .review-card { background: var(--graphite); border: 1px solid var(--stone); border-radius: 8px; padding: 18px; margin-bottom: 16px; }
        .review-card .property-name { font-size: 12px; color: var(--brass); text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 8px; }
        .review-card .stars { color: var(--brass); font-size: 14px; margin-bottom: 4px; }
        .review-card .date { font-size: 12px; color: var(--warm-grey); margin-bottom: 10px; }
        .review-card .body-text { font-size: 14px; line-height: 1.6; margin-bottom: 10px; }
        .sub-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: 4px 16px; margin-bottom: 12px; }
        .sub-item { font-size: 12px; color: var(--warm-grey); display: flex; justify-content: space-between; }
        .existing-reply { background: var(--ink); border: 1px solid var(--stone); border-radius: 6px; padding: 12px 14px; margin-top: 10px; }
        .existing-reply .label { font-size: 11px; color: var(--brass); text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 4px; }
        .reply-form { margin-top: 12px; border-top: 1px solid var(--stone); padding-top: 12px; }
        .field-label { display: block; font-size: 11px; letter-spacing: 0.05em; text-transform: uppercase; color: var(--warm-grey); margin-bottom: 6px; }
        .reply-form textarea { width: 100%; background: var(--ink); border: 1px solid var(--stone); color: var(--ivory); padding: 10px 12px; border-radius: 4px; font-family: var(--font-body); font-size: 13px; min-height: 70px; resize: vertical; margin-bottom: 8px; }
        .btn-secondary { background: transparent; border: 1px solid var(--brass); color: var(--brass); padding: 9px 16px; border-radius: 4px; font-family: var(--font-body); font-size: 13px; cursor: pointer; }
        .btn-secondary:disabled { opacity: 0.6; cursor: wait; }
        .reply-error { font-size: 12px; color: var(--error); margin-bottom: 8px; }
      `}</style>

      {state === "loading" && <div className="state-block">{ht("Loading reviews…")}</div>}
      {state === "unauthenticated" && (
        <div className="state-block">
          <p style={{ marginBottom: 16 }}>{ht("Sign in to your host account.")}</p>
          <a href={`/login?returnTo=${encodeURIComponent("/host/reviews")}`} className="btn-primary">{ht("Sign in")}</a>
        </div>
      )}
      {state === "forbidden" && <div className="state-block">{ht("This account doesn't have host access.")}</div>}
      {state === "error" && <div className="state-block">{ht("Something went wrong loading reviews. Please try again shortly.")}</div>}

      {state === "loaded" && (
        <>
          <div className="header"><h1 className="display">{ht("Reviews")}</h1></div>
          <HostNav active="reviews" />

          <div className="wrap">
            {properties.length > 1 && (
              <div className="filter-row">
                <button className={`filter-btn ${propertyFilter === "all" ? "active" : ""}`} onClick={() => setPropertyFilter("all")}>{ht("All properties")}</button>
                {properties.map(([id, name]) => (
                  <button key={id} className={`filter-btn ${propertyFilter === id ? "active" : ""}`} onClick={() => setPropertyFilter(id)}>{name}</button>
                ))}
              </div>
            )}

            {visibleReviews.length === 0 && <p style={{ color: "var(--warm-grey)", fontSize: 13 }}>{ht("No reviews yet for your properties.")}</p>}

            {visibleReviews.map((r) => (
              <div className="review-card" key={r.id}>
                <div className="property-name">{r.property_name}</div>
                <div className="stars">{"★".repeat(r.overall)}{"☆".repeat(5 - r.overall)}</div>
                <div className="date">{hDate(r.created_at)}</div>
                {r.body && <p className="body-text">{r.body}</p>}
                <div className="sub-grid">
                  {SUB_LABELS.map(({ key, label }) => {
                    const value = r[key];
                    if (!value) return null;
                    return <div className="sub-item" key={key}><span>{ht(label)}</span><span>{value}/5</span></div>;
                  })}
                </div>

                {r.host_reply ? (
                  <div className="existing-reply">
                    <div className="label">{ht("Your reply")}</div>
                    <p style={{ fontSize: 13, margin: 0 }}>{r.host_reply}</p>
                    {r.host_reply_at && <p style={{ fontSize: 11, color: "var(--warm-grey)", marginTop: 6, marginBottom: 0 }}>{hDate(r.host_reply_at)}</p>}
                  </div>
                ) : (
                  <ReplyForm review={r} onReplied={handleReplied} />
                )}
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
