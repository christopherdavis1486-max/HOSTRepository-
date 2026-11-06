"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";

type Review = {
  sourceAuditId: string;
  recordedAt: string;
  phase: string;
  trackingStatus: string;
  version: number;
  case: {
    assignedTo: string | null;
    resolvedAt: string | null;
    resolutionCode: string | null;
    resolutionNote: string | null;
  } | null;
};
type Action = "claim" | "resolve" | "reopen";
type Update = {
  sourceAuditId: string;
  expectedVersion: number;
  action: Action;
  note: string;
  resolutionCode?: string;
};

function ReviewForm({ review, busy, submit }: {
  review: Review; busy: boolean; submit: (input: Update) => Promise<void>;
}) {
  const [note, setNote] = useState("");
  const [action, setAction] = useState<Action>(
    review.trackingStatus === "resolved" ? "reopen" : "claim"
  );
  const [resolutionCode, setResolutionCode] = useState("investigation_complete");
  function save(event: FormEvent) {
    event.preventDefault();
    void submit({
      sourceAuditId: review.sourceAuditId,
      expectedVersion: review.version,
      action,
      note: note.trim(),
      ...(action === "resolve" ? { resolutionCode } : {}),
    });
  }
  return <form onSubmit={save}>
    <fieldset disabled={busy} style={{ border: 0, padding: 0 }}>
      <label>Action{" "}
        <select value={action} onChange={event => setAction(event.target.value as Action)}>
          {review.trackingStatus === "resolved" ? (
            <option value="reopen">Reopen and assign to me</option>
          ) : <>
            <option value="claim">Claim / assign to me</option>
            {review.case && <option value="resolve">Resolve investigation</option>}
          </>}
        </select>
      </label>
      {action === "resolve" && <p><label>Resolution{" "}
        <select value={resolutionCode} onChange={event => setResolutionCode(event.target.value)}>
          <option value="investigation_complete">Investigation complete</option>
          <option value="duplicate_case">Duplicate case</option>
          <option value="no_action_required">No action required</option>
        </select>
      </label></p>}
      <p><label>Investigation note
        <textarea name="reviewNote" value={note}
          onChange={event => setNote(event.target.value)}
          required minLength={8} maxLength={2000}
          style={{ display: "block", width: "100%", minHeight: 90 }} />
      </label></p>
      <button type="submit" disabled={busy || note.trim().length < 8}>
        Save review update
      </button>
    </fieldset>
  </form>;
}

export function SetupReviewCases({ bookingId }: { bookingId: string }) {
  const [records, setRecords] = useState<Review[] | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const active = useRef(false);
  const inFlight = useRef(false);
  useEffect(() => {
    active.current = true;
    return () => { active.current = false; };
  }, []);

  async function refresh() {
    const response = await fetch(
      "/api/admin/setup-review-cases?bookingId=" + encodeURIComponent(bookingId),
      { credentials: "include", cache: "no-store" },
    );
    const data = await response.json();
    if (!response.ok || data.success !== true || !Array.isArray(data.reviews?.records)) {
      throw new Error("Unable to load reviews. Check your administrative access and try loading again.");
    }
    if (active.current) {
      setRecords(data.reviews.records);
      setHasMore(data.reviews.hasMore === true);
    }
  }
  async function load() {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true); setError(""); setMessage(""); setRecords(null);
    try { await refresh(); }
    catch {
      if (active.current) setError("Unable to load reviews. Check your administrative access and try loading again.");
    } finally {
      inFlight.current = false;
      if (active.current) setBusy(false);
    }
  }
  async function submit(input: Update) {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true); setError(""); setMessage("");
    let outcome = "The update could not be confirmed. Check the reloaded review before trying again.";
    try {
      const response = await fetch("/api/admin/setup-review-cases", {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bookingId, ...input }),
      });
      const data = await response.json();
      if (response.ok && data.success === true) {
        outcome = "Review update saved.";
      } else if (response.status === 409) {
        outcome = "The review changed or this action is unavailable. Check the reloaded review.";
      } else if (response.status === 403 || response.status === 401) {
        outcome = "Review update denied. Check your administrative access.";
      }
    } catch {
      // A lost response does not establish that the update was not committed.
    }
    if (active.current) setRecords(null);
    try {
      await refresh();
      if (active.current) setMessage(outcome);
    } catch {
      if (active.current) {
        setError(outcome + " Reload reviews before another update.");
      }
    } finally {
      inFlight.current = false;
      if (active.current) setBusy(false);
    }
  }

  return <section aria-labelledby="setup-cases-heading" style={{ marginTop: 32 }}>
    <h2 id="setup-cases-heading">Setup investigation cases</h2>
    <p>Track the operator and investigation outcome for recorded setup failures.
      Resolving a case does not confirm payment or authorize a retry.</p>
    <p>Secure administrator access is required. Updates require reconciliation write permission.
      Only the assigned operator can resolve a case.</p>
    <button type="button" onClick={() => void load()} disabled={busy}>
      {busy ? "Loading / saving reviews?" : "Load / reload reviews"}
    </button>
    {error && <p role="alert">{error}</p>}
    {message && <p role="status">{message}</p>}
    {records?.length === 0 && <p>No matching review evidence found.
      This does not establish that setup or payment succeeded.</p>}
    {records?.map(review => <article key={review.sourceAuditId + ":" + review.version}
      style={{ border: "1px solid", padding: 16, marginTop: 16, overflowWrap: "anywhere" }}>
      <h3>{review.phase === "immediate_charge"
        ? "Immediate charge follow-up" : "Saving payment method"}</h3>
      <p>Review: {review.sourceAuditId}</p>
      <p>Recorded: {new Date(review.recordedAt).toISOString()} UTC</p>
      <p>Status: {review.trackingStatus} ? Version: {review.version}</p>
      <p>Assigned operator: {review.case?.assignedTo ?? "Unassigned"}</p>
      {review.case?.resolvedAt && <>
        <p>Resolved: {new Date(review.case.resolvedAt).toISOString()} UTC</p>
        <p>Resolution: {review.case.resolutionCode}</p>
        <p>{review.case.resolutionNote}</p>
      </>}
      <ReviewForm review={review} busy={busy} submit={submit} />
    </article>)}
    {records && hasMore && <p>Showing the 50 newest evidence records. Older records also exist.</p>}
  </section>;
}
