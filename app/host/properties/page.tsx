"use client";

import { useEffect, useState } from "react";
import { HostNav } from "@/components/HostNav";
import { useHostI18n } from "@/lib/i18n/useHostI18n";

type HostProperty = {
  id: string; name: string; slug: string | null; city: string; district: string | null;
  propertyType: string | null; status: string; currency: string; nightlyPrice: string | number;
  maxGuests: number; bedrooms: number | null; upcomingBookingCount: number;
};
type State = "checking" | "unauthenticated" | "forbidden" | "error" | "loaded";

export default function HostPropertiesPage() {
  const { ht, hStatus, hCurrency } = useHostI18n();
  const [properties, setProperties] = useState<HostProperty[]>([]);
  const [state, setState] = useState<State>("checking");

  useEffect(() => {
    fetch("/api/host/properties", { credentials: "include" })
      .then(async (res) => {
        if (res.status === 401) { setState("unauthenticated"); return; }
        if (res.status === 403) { setState("forbidden"); return; }
        const data = await res.json();
        if (!data.success) { setState("error"); return; }
        setProperties(data.properties);
        setState("loaded");
      })
      .catch(() => setState("error"));
  }, []);

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
        .header.header-row { display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 12px; }
        .header h1 { font-size: 26px; font-weight: 400; }
        .state-block { max-width: 1080px; margin: 60px auto; padding: 0 28px; text-align: center; color: var(--warm-grey); }
        .error-box { background: rgba(224,121,107,0.12); border: 1px solid var(--error); color: var(--error); padding: 14px 18px; border-radius: 6px; display: inline-block; }
        .btn-primary { background: var(--brass); color: var(--ink); border: none; padding: 12px 22px; border-radius: 4px; font-family: var(--font-body); font-size: 14px; font-weight: 500; cursor: pointer; text-decoration: none; display: inline-block; margin-top: 16px; }

        .wrap { max-width: 1080px; margin: 0 auto; padding: 28px 28px 80px; }
        .property-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px; }
        @media (max-width: 900px) { .property-grid { grid-template-columns: repeat(2, 1fr); } }
        @media (max-width: 600px) { .property-grid { grid-template-columns: 1fr; } }
        .property-card { display: block; text-decoration: none; color: inherit; background: var(--graphite); border: 1px solid var(--stone); border-radius: 8px; padding: 18px; }
        .property-card:hover { border-color: var(--brass); }
        .property-card .name { font-family: var(--font-display), Georgia, serif; font-size: 17px; margin-bottom: 4px; }
        .property-card .location { font-size: 13px; color: var(--warm-grey); margin-bottom: 12px; }
        .property-card .meta-row { display: flex; justify-content: space-between; font-size: 13px; border-top: 1px solid var(--stone); padding-top: 10px; margin-top: 4px; }
        .property-card .status-tag { font-size: 11px; letter-spacing: 0.05em; text-transform: uppercase; color: var(--brass); margin-bottom: 8px; display: inline-block; }
      `}</style>

      <div className="top-link"><a href="/">← {ht("Back to HOST")}</a></div>

      {state === "checking" && <div className="state-block">{ht("Loading your properties…")}</div>}

      {state === "unauthenticated" && (
        <div className="state-block">
          <p style={{ marginBottom: 16 }}>{ht("Sign in to your host account.")}</p>
          <a href={`/login?returnTo=${encodeURIComponent("/host/properties")}`} className="btn-primary">{ht("Sign in")}</a>
        </div>
      )}

      {state === "forbidden" && (
        <div className="state-block"><div className="error-box">{ht("This account doesn't have host access.")}</div></div>
      )}

      {state === "error" && (
        <div className="state-block"><div className="error-box">{ht("Something went wrong loading your properties. Please try again shortly.")}</div></div>
      )}

      {state === "loaded" && (
        <>
          <div className="header header-row"><h1 className="display">{ht("Properties")}</h1><a href="/host/properties/new" className="btn-primary" style={{ marginTop: 0 }}>+ {ht("Add property")}</a></div>
          <HostNav active="properties" />

          <div className="wrap">
            {properties.length === 0 ? (
              <div className="state-block">{ht("No properties yet.")}</div>
            ) : (
              <div className="property-grid">
                {properties.map((p) => (
                  <a href={`/host/properties/${p.id}`} key={p.id} className="property-card">
                    <span className="status-tag">{hStatus(p.status)}</span>
                    <div className="name display">{p.name}</div>
                    <div className="location">{[p.district, p.city].filter(Boolean).join(", ")}{p.propertyType ? ` · ${ht(p.propertyType)}` : ""}</div>
                    <div className="meta-row">
                      <span>{hCurrency(Number(p.nightlyPrice) * 100, p.currency)}/{ht("night")}</span>
                      <span>{p.maxGuests} {ht(p.maxGuests === 1 ? "guest" : "guests")}{p.bedrooms != null ? ` · ${p.bedrooms} ${ht(p.bedrooms === 1 ? "bed" : "beds")}` : ""}</span>
                    </div>
                    <div className="meta-row" style={{ borderTop: "none", paddingTop: 0, marginTop: 6, color: "var(--warm-grey)" }}>
                      {p.upcomingBookingCount} {ht(p.upcomingBookingCount === 1 ? "upcoming booking" : "upcoming bookings")}
                    </div>
                  </a>
                ))}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
