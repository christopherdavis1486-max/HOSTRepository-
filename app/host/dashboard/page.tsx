"use client";

import { useEffect, useState } from "react";
import { HostNav } from "@/components/HostNav";
import { groupHostBookings } from "@/lib/booking/hostBookingGrouping";
import { useHostI18n } from "@/lib/i18n/useHostI18n";

/**
 * Every number on this page is either a raw count of real rows already
 * fetched (upcoming bookings, property count) or a value read directly
 * from an existing, authoritative endpoint (onboarding status). Nothing
 * here is estimated, averaged, or invented — per the brief's explicit
 * "do not fabricate dashboard statistics; if a metric cannot be derived
 * reliably from existing data, omit it." No revenue/earnings total is
 * shown on this page for exactly that reason: summing host_payout_minor
 * across bookings would need real thought about which statuses to
 * include (scheduled vs already paid vs cancelled) that this batch's
 * scope doesn't call for — omitted rather than guessed at.
 */

type HostBooking = {
  id: string; propertyName: string; city: string; district: string | null;
  checkIn: string; checkOut: string; guests: number; guestName: string;
  status: string; paymentFlowVersion: string; paymentStatus: string | null; guestPaymentStatus: string | null; totalMinor: number | null; currency: string | null;
};
type HostProperty = {
  id: string; name: string; slug: string | null; city: string; district: string | null;
  status: string; currency: string; nightlyPrice: string | number; maxGuests: number; upcomingBookingCount: number;
};
type OnboardingStatus = "active" | "pending" | "not_connected";
type State = "checking" | "unauthenticated" | "forbidden" | "error" | "loaded";

export default function HostDashboardPage() {
  const { ht, hDate, hStatus, hCurrency } = useHostI18n();
  const [bookings, setBookings] = useState<HostBooking[]>([]);
  const [properties, setProperties] = useState<HostProperty[]>([]);
  const [payoutStatus, setPayoutStatus] = useState<OnboardingStatus | null>(null);
  const [state, setState] = useState<State>("checking");

  useEffect(() => {
    Promise.all([
      fetch("/api/host/bookings", { credentials: "include" }),
      fetch("/api/host/properties", { credentials: "include" }),
      fetch("/api/hosts/onboarding/status", { credentials: "include" }),
    ])
      .then(async ([bookingsRes, propertiesRes, onboardingRes]) => {
        if (bookingsRes.status === 401 || propertiesRes.status === 401) { setState("unauthenticated"); return; }
        if (bookingsRes.status === 403 || propertiesRes.status === 403) { setState("forbidden"); return; }

        const bookingsData = await bookingsRes.json();
        const propertiesData = await propertiesRes.json();
        if (!bookingsData.success || !propertiesData.success) { setState("error"); return; }

        setBookings(bookingsData.bookings);
        setProperties(propertiesData.properties);

        if (onboardingRes.ok) {
          const onboardingData = await onboardingRes.json();
          if (onboardingData.success) setPayoutStatus(onboardingData.status);
        }
        setState("loaded");
      })
      .catch(() => setState("error"));
  }, []);

  const { upcoming } = groupHostBookings(bookings);
  const needsAttention = bookings.filter((b) => b.status === "pending_payment");

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
        .header .eyebrow { font-size: 11px; letter-spacing: 0.12em; text-transform: uppercase; color: var(--brass); margin-bottom: 6px; }
        .header h1 { font-size: 26px; font-weight: 400; }
        .state-block { max-width: 1080px; margin: 60px auto; padding: 0 28px; text-align: center; color: var(--warm-grey); }
        .error-box { background: rgba(224,121,107,0.12); border: 1px solid var(--error); color: var(--error); padding: 14px 18px; border-radius: 6px; display: inline-block; }
        .btn-primary { background: var(--brass); color: var(--ink); border: none; padding: 12px 22px; border-radius: 4px; font-family: var(--font-body); font-size: 14px; font-weight: 500; cursor: pointer; text-decoration: none; display: inline-block; margin-top: 16px; }

        .wrap { max-width: 1080px; margin: 0 auto; padding: 28px 28px 80px; }
        .overview-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 14px; margin-bottom: 36px; }
        @media (max-width: 700px) { .overview-grid { grid-template-columns: repeat(2, 1fr); } }
        .stat-card { background: var(--graphite); border: 1px solid var(--stone); border-radius: 8px; padding: 18px; }
        .stat-card .value { font-family: var(--font-display), Georgia, serif; font-size: 26px; color: var(--brass); }
        .stat-card .label { font-size: 12px; color: var(--warm-grey); margin-top: 4px; }
        .stat-card.attention .value { color: var(--error); }

        .section { margin-bottom: 36px; }
        .section h2 { font-size: 15px; letter-spacing: 0.06em; text-transform: uppercase; color: var(--brass); font-weight: 400; margin-bottom: 14px; }

        table { width: 100%; border-collapse: collapse; font-size: 13px; }
        th { text-align: left; color: var(--warm-grey); font-weight: 400; font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; padding: 8px 10px; border-bottom: 1px solid var(--stone); }
        td { padding: 10px; border-bottom: 1px solid var(--stone); }
        tr:last-child td { border-bottom: none; }
        .table-wrap { overflow-x: auto; background: var(--graphite); border: 1px solid var(--stone); border-radius: 8px; }
        table td, table th { white-space: nowrap; }

        .property-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 14px; }
        @media (max-width: 700px) { .property-grid { grid-template-columns: 1fr; } }
        .property-card { display: block; text-decoration: none; color: inherit; background: var(--graphite); border: 1px solid var(--stone); border-radius: 8px; padding: 16px 18px; }
        .property-card:hover { border-color: var(--brass); }
        .property-card .name { font-family: var(--font-display), Georgia, serif; font-size: 16px; margin-bottom: 4px; }
        .property-card .meta { font-size: 12px; color: var(--warm-grey); }

        .actions-row { display: flex; gap: 12px; flex-wrap: wrap; }
        .action-link { background: var(--graphite); border: 1px solid var(--stone); border-radius: 6px; padding: 14px 18px; text-decoration: none; color: var(--ivory); font-size: 14px; flex: 1; min-width: 200px; }
        .action-link:hover { border-color: var(--brass); }
        .action-link .sub { display: block; font-size: 12px; color: var(--warm-grey); margin-top: 4px; }
        .empty-note { color: var(--warm-grey); font-size: 13px; padding: 16px; }
      `}</style>

      <div className="top-link"><a href="/">← {ht("Back to HOST")}</a></div>

      {state === "checking" && <div className="state-block">{ht("Loading your dashboard…")}</div>}

      {state === "unauthenticated" && (
        <div className="state-block">
          <p style={{ marginBottom: 16 }}>{ht("Sign in to your host account.")}</p>
          <a href={`/login?returnTo=${encodeURIComponent("/host/dashboard")}`} className="btn-primary">{ht("Sign in")}</a>
        </div>
      )}

      {state === "forbidden" && (
        <div className="state-block"><div className="error-box">{ht("This account doesn't have host access.")}</div></div>
      )}

      {state === "error" && (
        <div className="state-block"><div className="error-box">{ht("Something went wrong loading your dashboard. Please try again shortly.")}</div></div>
      )}

      {state === "loaded" && (
        <>
          <div className="header">
            <div className="eyebrow">{ht("HOST · Hosting")}</div>
            <h1 className="display">{ht("Welcome back")}</h1>
          </div>
          <HostNav active="dashboard" />

          <div className="wrap">
            <div className="overview-grid">
              <div className="stat-card">
                <div className="value">{upcoming.length}</div>
                <div className="label">{ht("Upcoming stays")}</div>
              </div>
              <div className="stat-card">
                <div className="value">{properties.length}</div>
                <div className="label">{ht("Properties")}</div>
              </div>
              <div className={`stat-card ${needsAttention.length > 0 ? "attention" : ""}`}>
                <div className="value">{needsAttention.length}</div>
                <div className="label">{ht("Bookings requiring attention")}</div>
              </div>
              <div className="stat-card">
                <div className="value" style={{ fontSize: 18 }}>
                  {payoutStatus === "active" ? ht("Connected") : payoutStatus === "pending" ? ht("Action required") : ht("Not connected")}
                </div>
                <div className="label">{ht("Payout account")}</div>
              </div>
            </div>

            <div className="section">
              <h2>{ht("Upcoming bookings")}</h2>
              {upcoming.length === 0 ? (
                <div className="table-wrap"><div className="empty-note">{ht("No upcoming bookings yet.")}</div></div>
              ) : (
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr><th>{ht("Property")}</th><th>{ht("Guest")}</th><th>{ht("Check-in")}</th><th>{ht("Check-out")}</th><th>{ht("Guests")}</th><th>{ht("Status")}</th><th>{ht("Payment")}</th></tr>
                    </thead>
                    <tbody>
                      {upcoming.map((b) => (
                        <tr key={b.id}>
                          <td><a href={`/host/bookings/${b.id}`} style={{ color: "var(--ivory)", textDecoration: "none" }}>{b.propertyName}</a></td>
                          <td>{b.guestName}</td>
                          <td>{hDate(b.checkIn)}</td>
                          <td>{hDate(b.checkOut)}</td>
                          <td>{b.guests}</td>
                          <td>{hStatus(b.status)}</td>
                          <td>{hStatus(b.paymentFlowVersion === "separate_charges_delayed_v1" ? b.guestPaymentStatus : b.paymentStatus)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            <div className="section">
              <h2>{ht("Properties")}</h2>
              {properties.length === 0 ? (
                <div className="empty-note">{ht("No properties yet.")}</div>
              ) : (
                <div className="property-grid">
                  {properties.map((p) => (
                    <a href={`/host/properties/${p.id}`} key={p.id} className="property-card">
                      <div className="name display">{p.name}</div>
                      <div className="meta">
                        {[p.district, p.city].filter(Boolean).join(", ")} · {hCurrency(Number(p.nightlyPrice) * 100, p.currency)}/{ht("night")} · {p.upcomingBookingCount} {p.upcomingBookingCount === 1 ? ht("upcoming booking") : ht("upcoming bookings")}
                      </div>
                    </a>
                  ))}
                </div>
              )}
            </div>

            <div className="section">
              <h2>{ht("Quick actions")}</h2>
              <div className="actions-row">
                <a href="/host/bookings" className="action-link">{ht("View bookings")}<span className="sub">{ht("All bookings across your properties")}</span></a>
                <a href="/host/properties" className="action-link">{ht("View properties")}<span className="sub">{ht("Manage your listings")}</span></a>
                <a href="/host/onboarding/complete" className="action-link">
                  {ht("Payout account")}
                  <span className="sub">{payoutStatus === "active" ? ht("Connected") : ht("Complete Stripe Connect setup")}</span>
                </a>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
