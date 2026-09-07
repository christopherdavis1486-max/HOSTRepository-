"use client";

import { useEffect, useState } from "react";
import { HostNav } from "@/components/HostNav";
import { groupHostBookings } from "@/lib/booking/hostBookingGrouping";
import { useHostI18n } from "@/lib/i18n/useHostI18n";

type HostBooking = {
  id: string; propertyName: string; city: string; district: string | null;
  checkIn: string; checkOut: string; guests: number; guestName: string;
  status: string; paymentFlowVersion: string; paymentStatus: string | null; guestPaymentStatus: string | null;
  totalMinor: number | null; currency: string | null;
};
type State = "checking" | "unauthenticated" | "forbidden" | "error" | "loaded";

export default function HostBookingsPage() {
  const { ht, hDate, hStatus, hCurrency } = useHostI18n();
  const [bookings, setBookings] = useState<HostBooking[]>([]);
  const [state, setState] = useState<State>("checking");

  useEffect(() => {
    fetch("/api/host/bookings", { credentials: "include" })
      .then(async (res) => {
        if (res.status === 401) { setState("unauthenticated"); return; }
        if (res.status === 403) { setState("forbidden"); return; }
        const data = await res.json();
        if (!data.success) { setState("error"); return; }
        setBookings(data.bookings);
        setState("loaded");
      })
      .catch(() => setState("error"));
  }, []);

  const { upcoming, current, past, cancelled } = groupHostBookings(bookings);

  const renderTable = (label: string, group: HostBooking[]) => (
    group.length > 0 && (
      <div className="section">
        <h2>{label}</h2>
        <div className="table-wrap">
          <table>
            <thead>
              <tr><th>{ht("Property")}</th><th>{ht("Guest")}</th><th>{ht("Check-in")}</th><th>{ht("Check-out")}</th><th>{ht("Guests")}</th><th>{ht("Status")}</th><th>{ht("Payment")}</th><th>{ht("Total")}</th></tr>
            </thead>
            <tbody>
              {group.map((b) => (
                <tr key={b.id} onClick={() => { window.location.href = `/host/bookings/${b.id}`; }} style={{ cursor: "pointer" }}>
                  <td>{b.propertyName}</td>
                  <td>{b.guestName}</td>
                  <td>{hDate(b.checkIn)}</td>
                  <td>{hDate(b.checkOut)}</td>
                  <td>{b.guests}</td>
                  <td>{hStatus(b.status)}</td>
                  <td>{hStatus(b.paymentFlowVersion === "separate_charges_delayed_v1" ? b.guestPaymentStatus : b.paymentStatus)}</td>
                  <td>{hCurrency(b.totalMinor, b.currency)}</td>
                </tr>
              ))}
            </tbody>
          </table>
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
        .top-link { display: block; padding: 24px 28px 0; }
        .top-link a { color: var(--warm-grey); font-size: 13px; text-decoration: none; }
        .header { max-width: 1080px; margin: 0 auto; padding: 8px 28px 20px; }
        .header h1 { font-size: 26px; font-weight: 400; }
        .state-block { max-width: 1080px; margin: 60px auto; padding: 0 28px; text-align: center; color: var(--warm-grey); }
        .error-box { background: rgba(224,121,107,0.12); border: 1px solid var(--error); color: var(--error); padding: 14px 18px; border-radius: 6px; display: inline-block; }
        .btn-primary { background: var(--brass); color: var(--ink); border: none; padding: 12px 22px; border-radius: 4px; font-family: var(--font-body); font-size: 14px; font-weight: 500; cursor: pointer; text-decoration: none; display: inline-block; margin-top: 16px; }

        .wrap { max-width: 1080px; margin: 0 auto; padding: 28px 28px 80px; }
        .section { margin-bottom: 32px; }
        .section h2 { font-size: 13px; letter-spacing: 0.1em; text-transform: uppercase; color: var(--brass); font-weight: 400; margin-bottom: 14px; }
        table { width: 100%; border-collapse: collapse; font-size: 13px; }
        th { text-align: left; color: var(--warm-grey); font-weight: 400; font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; padding: 8px 10px; border-bottom: 1px solid var(--stone); }
        td { padding: 10px; border-bottom: 1px solid var(--stone); }
        tr:last-child td { border-bottom: none; }
        tr:hover td { background: rgba(201,151,75,0.05); }
        .table-wrap { overflow-x: auto; background: var(--graphite); border: 1px solid var(--stone); border-radius: 8px; }
        table td, table th { white-space: nowrap; }
      `}</style>

      <div className="top-link"><a href="/">← {ht("Back to HOST")}</a></div>

      {state === "checking" && <div className="state-block">{ht("Loading your bookings…")}</div>}

      {state === "unauthenticated" && (
        <div className="state-block">
          <p style={{ marginBottom: 16 }}>{ht("Sign in to your host account.")}</p>
          <a href={`/login?returnTo=${encodeURIComponent("/host/bookings")}`} className="btn-primary">{ht("Sign in")}</a>
        </div>
      )}

      {state === "forbidden" && (
        <div className="state-block"><div className="error-box">{ht("This account doesn't have host access.")}</div></div>
      )}

      {state === "error" && (
        <div className="state-block"><div className="error-box">{ht("Something went wrong loading your bookings. Please try again shortly.")}</div></div>
      )}

      {state === "loaded" && (
        <>
          <div className="header"><h1 className="display">{ht("Bookings")}</h1></div>
          <HostNav active="bookings" />

          <div className="wrap">
            {bookings.length === 0 && <div className="state-block">{ht("No bookings yet.")}</div>}
            {renderTable(ht("Upcoming"), upcoming)}
            {renderTable(ht("Current"), current)}
            {renderTable(ht("Past"), past)}
            {renderTable(ht("Cancelled / Refunded"), cancelled)}
          </div>
        </>
      )}
    </div>
  );
}
