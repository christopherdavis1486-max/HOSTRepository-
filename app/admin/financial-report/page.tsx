"use client";

import { useState, type FormEvent } from "react";
import Link from "next/link";
import { SetupReviewCases } from "@/components/SetupReviewCases";
import { formatStatus, formatCurrency } from "@/lib/presentation/formatters";

type QueuedReview = {
  reviewId: string;
  bookingId: string;
  recordedAt: string;
  phase: "payment_method_save" | "immediate_charge";
  status: "unclaimed" | "open" | "in_review";
  assignedTo: string | null;
};

const queueStatusLabels = {
  unclaimed: "Unclaimed",
  open: "Open",
  in_review: "In review",
};

type FinancialRow = {
  status?: string; amount_minor?: number; amountMinor?: number;
  currency?: string; scheduled_release_at?: string;
  attempt_number?: number;
};
type Report = {
  bookingId: string; paymentFlowVersion: string; bookingStatus: string;
  paymentStatus: string | null; payoutDisplayLabel: string | null;
  legacyPayoutStatus: string | null;
  breakdown: { currency: string; guestTotalMinor: number; hostPayoutMinor?: number } | null;
  refunds: FinancialRow[]; paymentAttempts: FinancialRow[];
  transfers: FinancialRow[]; retainedSettlements: FinancialRow[];
  transferReversals: FinancialRow[];
  skippedSetupReferenceHistory: {
    records: {
      id: string; recordedAt: string;
      reason: "historical_reference_not_current" | "unknown";
    }[];
    hasMore: boolean;
  };
  setupReviewHistory: {
    records: {
      id: string; recordedAt: string;
      phase: "payment_method_save" | "immediate_charge" | "unknown";
    }[];
    hasMore: boolean;
  };
};

function Records({ title, rows, showRelease = false }: { title: string; rows: FinancialRow[]; showRelease?: boolean }) {
  return <section style={{ marginTop: 24 }}>
    <h2>{title}</h2>
    {rows.length === 0 ? <p>No records.</p> :
      <div style={{ overflowX: "auto" }}><table style={{ width: "100%", textAlign: "left" }}>
        <thead><tr><th>Status</th><th>Amount</th>{showRelease && <th>Scheduled release</th>}</tr></thead>
        <tbody>{rows.map((row, index) => <tr key={index}>
          <td>{formatStatus(row.status)}</td>
          <td>{formatCurrency(row.amountMinor ?? row.amount_minor, row.currency)}</td>
          {showRelease && <td>{row.scheduled_release_at
            ? new Date(row.scheduled_release_at).toLocaleString("en-GB") : "?"}</td>}
        </tr>)}</tbody>
      </table></div>}
  </section>;
}

export default function AdminFinancialReportPage() {
  const [bookingId, setBookingId] = useState("");
  const [report, setReport] = useState<Report | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const [queue, setQueue] = useState<QueuedReview[] | null>(null);
  const [queueCursor, setQueueCursor] = useState<string | null>(null);
  const [queueLoadedAt, setQueueLoadedAt] = useState(0);
  const [queueLoading, setQueueLoading] = useState(false);
  const [queueError, setQueueError] = useState("");

  async function loadReviewQueue(cursor: string | null = null) {
    setQueueLoading(true);
    setQueueError("");
    if (cursor === null) {
      setQueue(null);
      setQueueCursor(null);
    }
    try {
      const query = cursor === null ? "" : "?cursor=" + encodeURIComponent(cursor);
      const response = await fetch("/api/admin/setup-review-queue" + query, {
        credentials: "include",
        cache: "no-store",
      });
      if (response.status === 401 || response.status === 403) {
        setQueue(null);
        setQueueCursor(null);
        setQueueError("Review queue access is not available.");
        return;
      }
      const data = await response.json();
      if (!response.ok || data.success !== true || !Array.isArray(data.records)) {
        throw new Error("Queue load failed");
      }
      if (data.hasMore === true && (
        typeof data.nextCursor !== "string" || !data.nextCursor || data.nextCursor === cursor
      )) {
        throw new Error("Invalid queue continuation");
      }
      const records: QueuedReview[] = data.records;
      setQueue(current => cursor === null ? records : [...(current ?? []), ...records]);
      setQueueCursor(data.hasMore === true ? data.nextCursor : null);
      setQueueLoadedAt(Date.now());
    } catch {
      setQueueError("Unable to load the setup review queue. Try loading it again.");
    } finally {
      setQueueLoading(false);
    }
  }

  function load(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void loadBooking(bookingId.trim());
  }

  async function loadBooking(id: string) {
    setBookingId(id);
    setLoading(true); setError(""); setReport(null);
    try {
      const response = await fetch(
        "/api/admin/financial-report?bookingId=" + encodeURIComponent(id),
        { credentials: "include", cache: "no-store" }
      );
      const data = await response.json();
      if (!response.ok || !data.success) throw new Error(data.error?.message ?? "Unable to load report.");
      setReport(data.report);
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : "Unable to load report.");
    } finally { setLoading(false); }
  }

  return <main style={{ maxWidth: 960, margin: "40px auto", padding: 24 }}>
    <nav aria-label="Admin navigation" style={{ display: "flex", flexWrap: "wrap", gap: 16, marginBottom: 24 }}>
      <Link href="/">Back to HOST</Link>
      <Link href="/admin/security">Admin security</Link>
      <Link href="/admin/property-compliance">Compliance review</Link>
      <Link href="/admin/listing-readiness">Pilot listing review</Link>
      <Link href="/admin/financial-report" aria-current="page">Financial report</Link>
    </nav>
    <h1>Booking financial report</h1>
    <p>Review recorded payments, refunds and host transfers for a booking.</p>
    <form onSubmit={load}>
      <label htmlFor="financial-booking-id">Booking ID</label>{" "}
      <input id="financial-booking-id" value={bookingId}
        onChange={event => setBookingId(event.target.value)}
        required disabled={loading} style={{ width: "min(100%, 380px)", padding: 10 }} />{" "}
      <button type="submit" disabled={loading}>{loading ? "Loading?" : "View report"}</button>
    </form>
    {error && <p role="alert">{error}</p>}

    <section aria-labelledby="setup-review-queue-heading" style={{ marginTop: 24 }}>
      <h2 id="setup-review-queue-heading">Unresolved setup reviews</h2>
      <p>Reviews across bookings, oldest first. Reload the queue after updating a case.</p>
      <button type="button" onClick={() => void loadReviewQueue()} disabled={queueLoading}>
        {queueLoading ? "Loading queue..." : "Load / reload review queue"}
      </button>
      {queueError && <p role="alert">{queueError}</p>}
      {queue?.length === 0 && <p>No unresolved setup reviews found.</p>}
      {queue && queue.length > 0 && (
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", textAlign: "left" }}>
            <thead><tr>
              <th scope="col">Review</th>
              <th scope="col">Age at load</th>
              <th scope="col">Status</th>
              <th scope="col">Assigned operator</th>
              <th scope="col">Booking</th>
            </tr></thead>
            <tbody>{queue.map(review => {
              const hours = Math.max(0, Math.floor(
                (queueLoadedAt - new Date(review.recordedAt).getTime()) / 3600000
              ));
              return <tr key={review.reviewId}>
                <td style={{ overflowWrap: "anywhere" }}>
                  {review.phase === "immediate_charge"
                    ? "Immediate charge follow-up" : "Saving payment method"}
                  <br />{review.reviewId}
                </td>
                <td>{hours === 0 ? "Under 1 hour" : hours + " h"}</td>
                <td>{queueStatusLabels[review.status]}</td>
                <td style={{ overflowWrap: "anywhere" }}>{review.assignedTo ?? "Unassigned"}</td>
                <td style={{ overflowWrap: "anywhere" }}>
                  {review.bookingId}<br />
                  <button type="button" disabled={loading}
                    aria-label={"Open booking report " + review.bookingId}
                    onClick={() => void loadBooking(review.bookingId)}>
                    Open booking report
                  </button>
                </td>
              </tr>;
            })}</tbody>
          </table>
        </div>
      )}
      {queue && queueCursor && (
        <div>
          <p>Showing {queue.length} reviews. More reviews are waiting.</p>
          <button type="button" disabled={queueLoading}
            onClick={() => void loadReviewQueue(queueCursor)}>
            Load more reviews
          </button>
        </div>
      )}
    </section>
    {report && <article>
      <h2>Booking {report.bookingId}</h2>
      <dl>
        <dt>Booking status</dt><dd>{formatStatus(report.bookingStatus)}</dd>
        <dt>Payment status</dt><dd>{formatStatus(report.paymentStatus)}</dd>
        <dt>Host transfer / payout</dt><dd>{report.payoutDisplayLabel ??
          formatStatus(report.legacyPayoutStatus)}</dd>
        <dt>Guest total</dt><dd>{formatCurrency(report.breakdown?.guestTotalMinor, report.breakdown?.currency)}</dd>
      </dl>
      <p>This report shows local records without checking the payment provider.
        Records may change while the report loads. A connected-account transfer does not confirm a bank payout.</p>
      <section aria-labelledby="setup-review-history-heading" style={{ marginTop: 24 }}>
        <h2 id="setup-review-history-heading">Payment setup review history</h2>
        <p>Recorded setup failures and charge follow-up may need investigation. This history does not
          show whether an issue is still open or has been resolved. Check current
          booking and payment records before taking action.</p>
        {report.setupReviewHistory.records.length === 0 ? (
          <p>No setup review records found. This does not establish that payment setup succeeded.</p>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", textAlign: "left" }}>
              <thead><tr>
                <th scope="col">Recorded</th>
                <th scope="col">Stage</th>
                <th scope="col">Review reference</th>
              </tr></thead>
              <tbody>{report.setupReviewHistory.records.map(record => (
                <tr key={record.id}>
                  <td>{new Date(record.recordedAt).toLocaleString("en-GB", { timeZone: "UTC" })} UTC</td>
                  <td>{record.phase === "payment_method_save"
                    ? "Saving payment method" : record.phase === "immediate_charge"
                      ? "Immediate charge follow-up" : "Unknown stage"}</td>
                  <td style={{ overflowWrap: "anywhere" }}>{record.id}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        )}
        {report.setupReviewHistory.hasMore && (
          <p>Showing the 50 newest records. Older review records also exist.</p>
        )}
        <p>This view does not retry payments or clear payment reservations.</p>
      </section>

      <section aria-labelledby="skipped-setup-history-heading" style={{ marginTop: 24 }}>
        <h2 id="skipped-setup-history-heading">Skipped setup delivery history</h2>
        <p>These records describe deliveries for historical setup references that
          were not current when recorded. They do not establish current ownership,
          payment completion or whether an incident is open or resolved.</p>
        {report.skippedSetupReferenceHistory.records.length === 0 ? (
          <p>No skipped setup delivery records found. This does not establish that all deliveries were processed.</p>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", textAlign: "left" }}>
              <thead><tr>
                <th scope="col">Recorded</th>
                <th scope="col">Reason</th>
                <th scope="col">Record reference</th>
              </tr></thead>
              <tbody>{report.skippedSetupReferenceHistory.records.map(record => (
                <tr key={record.id}>
                  <td>{new Date(record.recordedAt).toLocaleString("en-GB", { timeZone: "UTC" })} UTC</td>
                  <td>{record.reason === "historical_reference_not_current"
                    ? "Historical setup reference was not current" : "Unknown reason"}</td>
                  <td style={{ overflowWrap: "anywhere" }}>{record.id}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        )}
        {report.skippedSetupReferenceHistory.hasMore && (
          <p>Showing the 50 newest records. Older skipped delivery records also exist.</p>
        )}
        <p>This history does not authorize payment retries or changes to setup references.</p>
      </section>
      <SetupReviewCases key={report.bookingId} bookingId={report.bookingId} />
      <Records title="Refunds" rows={report.refunds} />
      <Records title="Payment attempts" rows={report.paymentAttempts} />
      <Records title="Host transfers" rows={report.transfers} showRelease />
      <Records title="Retained cancellation settlements" rows={report.retainedSettlements} showRelease />
      <Records title="Transfer reversals" rows={report.transferReversals} />
    </article>}
  </main>;
}
