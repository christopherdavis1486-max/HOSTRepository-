"use client";

import { useEffect, useState } from "react";
import { formatCurrency } from "@/lib/presentation/formatters";
import { useInterfaceI18n } from "@/lib/i18n/useInterfaceI18n";

type SavedProperty = {
  id: string; name: string; slug: string | null; city: string; district: string | null;
  nightly_price: string | number; currency: string; rating: string | number | null; review_count: number | null;
};

export default function FavouritesPage() {
  const { ui } = useInterfaceI18n();
  const [properties, setProperties] = useState<SavedProperty[]>([]);
  const [state, setState] = useState<"loading" | "unauthenticated" | "loaded" | "error">("loading");
  const [removing, setRemoving] = useState<string | null>(null);

  const load = () => {
    fetch("/api/favourites", { credentials: "include" })
      .then(async (res) => {
        if (res.status === 401) { setState("unauthenticated"); return; }
        const data = await res.json();
        if (!data.success) { setState("error"); return; }
        setProperties(data.properties);
        setState("loaded");
      })
      .catch(() => setState("error"));
  };
  useEffect(load, []);

  const handleRemove = async (propertyId: string) => {
    setRemoving(propertyId);
    try {
      await fetch(`/api/favourites/${propertyId}`, { method: "DELETE", credentials: "include" });
      setProperties((prev) => prev.filter((p) => p.id !== propertyId));
    } catch {
      // best-effort — leave the list as-is, the user can retry
    }
    setRemoving(null);
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
        .header { max-width: 1080px; margin: 0 auto; padding: 8px 28px 20px; }
        .header h1 { font-size: 26px; font-weight: 400; }
        .state-block { max-width: 1080px; margin: 60px auto; padding: 0 28px; text-align: center; color: var(--warm-grey); }
        .btn-primary { background: var(--brass); color: var(--ink); border: none; padding: 12px 22px; border-radius: 4px; font-family: var(--font-body); font-size: 14px; font-weight: 500; cursor: pointer; text-decoration: none; display: inline-block; margin-top: 16px; }
        .wrap { max-width: 1080px; margin: 0 auto; padding: 0 28px 80px; }
        .grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 18px; }
        @media (max-width: 900px) { .grid { grid-template-columns: repeat(2, 1fr); } }
        @media (max-width: 600px) { .grid { grid-template-columns: 1fr; } }
        .card { background: var(--graphite); border: 1px solid var(--stone); border-radius: 8px; padding: 18px; position: relative; }
        .card .name { font-family: var(--font-display), Georgia, serif; font-size: 16px; margin-bottom: 4px; }
        .card .location { font-size: 13px; color: var(--warm-grey); margin-bottom: 10px; }
        .card .price { color: var(--brass); font-family: var(--font-display), Georgia, serif; font-size: 15px; }
        .card .rating { font-size: 12px; color: var(--warm-grey); margin-top: 4px; }
        .card a.view-link { display: block; margin-top: 12px; font-size: 13px; color: var(--ivory); text-decoration: none; border-top: 1px solid var(--stone); padding-top: 10px; }
        .remove-btn { position: absolute; top: 14px; right: 14px; background: transparent; border: 1px solid var(--stone); color: var(--warm-grey); border-radius: 4px; padding: 4px 8px; font-size: 11px; cursor: pointer; }
        .remove-btn:hover { border-color: var(--error); color: var(--error); }
      `}</style>

      <div className="top-link"><a href="/">← {ui("backHost")}</a></div>

      {state === "loading" && <div className="state-block">{ui("loadingSaved")}</div>}

      {state === "unauthenticated" && (
        <div className="state-block">
          <p style={{ marginBottom: 16 }}>{ui("signInSaved")}</p>
          <a href={`/login?returnTo=${encodeURIComponent("/favourites")}`} className="btn-primary">{ui("signIn")}</a>
        </div>
      )}

      {state === "error" && <div className="state-block">{ui("savedError")}</div>}

      {state === "loaded" && (
        <>
          <div className="header"><h1 className="display">{ui("savedStays")}</h1></div>
          <div className="wrap">
            {properties.length === 0 ? (
              <div className="state-block">{ui("noSaved")} <a href="/search" style={{ color: "var(--brass)" }}>{ui("startExploring")}</a></div>
            ) : (
              <div className="grid">
                {properties.map((p) => (
                  <div className="card" key={p.id}>
                    <button className="remove-btn" onClick={() => handleRemove(p.id)} disabled={removing === p.id}>
                      {removing === p.id ? "…" : ui("remove")}
                    </button>
                    <div className="name display">{p.name}</div>
                    <div className="location">{[p.district, p.city].filter(Boolean).join(", ")}</div>
                    <div className="price">{formatCurrency(Number(p.nightly_price) * 100, p.currency)}/{ui("night")}</div>
                    {p.rating != null && p.review_count != null && (
                      <div className="rating">★ {Number(p.rating).toFixed(1)} ({p.review_count})</div>
                    )}
                    <a href={`/stays/${p.slug ?? p.id}`} className="view-link">{ui("viewStay")} →</a>
                  </div>
                ))}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
