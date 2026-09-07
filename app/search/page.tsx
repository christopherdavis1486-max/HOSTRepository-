"use client";

import { useEffect, useState } from "react";
import { CustomerNav } from "@/components/CustomerNav";
import { useGuestI18n } from "@/lib/i18n/useGuestI18n";

/**
 * Calls the EXISTING GET /api/properties directly — no new backend
 * logic here, this route is pure frontend. Query params read from
 * window.location.search on mount (same technique already used by
 * app/reset-password/page.tsx for its token), not next/navigation's
 * useSearchParams — that hook requires a <Suspense> boundary around any
 * statically-rendered page that uses it, and this technique avoids that
 * complexity entirely while achieving the same result.
 *
 * No property images exist in the schema (confirmed by GET
 * /api/properties itself, which returns no image fields at all — see
 * that route's own doc comment). Cards use a deliberate image-neutral
 * treatment instead of a placeholder: a typographic tile carrying the
 * city initial and property type, in the same gradient language already
 * established on the homepage's destination showcase, rather than an
 * empty grey box that reads as "broken" or "unfinished."
 */

type Property = {
  id: string;
  name: string;
  slug: string | null;
  city: string;
  district: string | null;
  property_type: string | null;
  currency: string;
  nightly_price: string | number;
  max_guests: number;
  bedrooms: number | null;
  bathrooms: number | null;
  rating: string | number | null;
  review_count: number | null;
};

type State = "loading" | "error" | "invalid" | "results";

export default function SearchPage() {
  const { gt } = useGuestI18n();
  const [properties, setProperties] = useState<Property[]>([]);
  const [state, setState] = useState<State>("loading");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [criteria, setCriteria] = useState<{ city?: string; checkIn?: string; checkOut?: string; guests?: string }>({});

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const city = params.get("city") ?? undefined;
    const checkIn = params.get("checkIn") ?? undefined;
    const checkOut = params.get("checkOut") ?? undefined;
    const guests = params.get("guests") ?? undefined;
    setCriteria({ city, checkIn, checkOut, guests });

    fetch(`/api/properties?${params.toString()}`)
      .then(async (res) => {
        const data = await res.json();
        if (res.status === 400) {
          setErrorMessage(data.error?.message ?? gt("invalidSearch"));
          setState("invalid");
          return;
        }
        if (!data.success) { setState("error"); return; }
        setProperties(data.properties);
        setState("results");
      })
      .catch(() => setState("error"));
  }, [gt]);

  const detailHref = (p: Property) => {
    const params = new URLSearchParams();
    if (criteria.checkIn) params.set("checkIn", criteria.checkIn);
    if (criteria.checkOut) params.set("checkOut", criteria.checkOut);
    if (criteria.guests) params.set("guests", criteria.guests);
    const qs = params.toString();
    return `/stays/${p.slug ?? p.id}${qs ? `?${qs}` : ""}`;
  };

  const criteriaLabel = [
    criteria.city,
    criteria.checkIn && criteria.checkOut ? `${criteria.checkIn} → ${criteria.checkOut}` : null,
    criteria.guests ? `${criteria.guests} ${criteria.guests === "1" ? gt("guest") : gt("guests")}` : null,
  ].filter(Boolean).join(" · ");

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
        .top-link a:hover { color: var(--ivory); }

        .header { max-width: 1080px; margin: 0 auto; padding: 8px 28px 32px; }
        .header h1 { font-size: 28px; font-weight: 400; margin-bottom: 6px; }
        .header .criteria { color: var(--warm-grey); font-size: 14px; }
        .header .criteria a { color: var(--brass); text-decoration: none; margin-left: 10px; }

        .state-block { max-width: 1080px; margin: 60px auto; padding: 0 28px; text-align: center; color: var(--warm-grey); }
        .error-box { background: rgba(224,121,107,0.12); border: 1px solid var(--error); color: var(--error); padding: 14px 18px; border-radius: 6px; display: inline-block; }

        .grid { max-width: 1080px; margin: 0 auto; padding: 0 28px 80px; display: grid; grid-template-columns: repeat(3, 1fr); gap: 20px; }
        @media (max-width: 900px) { .grid { grid-template-columns: repeat(2, 1fr); } }
        @media (max-width: 620px) { .grid { grid-template-columns: 1fr; } }

        .card { display: block; text-decoration: none; color: inherit; border: 1px solid var(--stone); border-radius: 8px; overflow: hidden; background: var(--graphite); transition: border-color 0.15s; }
        .card:hover { border-color: var(--brass); }
        .card-tile { height: 150px; background: linear-gradient(135deg, var(--stone) 0%, var(--ink) 100%); position: relative; display: flex; align-items: flex-end; padding: 14px; }
        .card-tile::after { content: ""; position: absolute; inset: 0; background: linear-gradient(180deg, transparent 30%, rgba(201,151,75,0.14) 100%); }
        .card-tile .initial { font-family: var(--font-display), Georgia, serif; font-size: 46px; color: rgba(242,236,222,0.15); position: absolute; top: 10px; left: 16px; }
        .card-tile .type-tag { position: relative; font-size: 11px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--brass); }
        .card-body { padding: 16px 18px 20px; }
        .card-body .name { font-family: var(--font-display), Georgia, serif; font-size: 17px; margin-bottom: 4px; }
        .card-body .location { font-size: 13px; color: var(--warm-grey); margin-bottom: 10px; }
        .card-meta { display: flex; justify-content: space-between; align-items: center; font-size: 13px; }
        .card-meta .price { color: var(--ivory); }
        .card-meta .price .amount { font-family: var(--font-display), Georgia, serif; font-size: 16px; color: var(--brass); }
        .card-meta .details { color: var(--warm-grey); }
        .card-rating { font-size: 12px; color: var(--warm-grey); margin-top: 6px; }
      `}</style>

      <CustomerNav />

      <div className="header">
        <h1 className="display">{gt("stays")}</h1>
        {criteriaLabel && <div className="criteria">{criteriaLabel}<a href="/">{gt("changeSearch")}</a></div>}
      </div>

      {state === "loading" && <div className="state-block">{gt("searching")}</div>}

      {state === "invalid" && (
        <div className="state-block">
          <div className="error-box">{errorMessage}</div>
        </div>
      )}

      {state === "error" && (
        <div className="state-block">
          <div className="error-box">{gt("loadStaysError")}</div>
        </div>
      )}

      {state === "results" && properties.length === 0 && (
        <div className="state-block">{gt("noStays")}</div>
      )}

      {state === "results" && properties.length > 0 && (
        <div className="grid">
          {properties.map((p) => (
            <a href={detailHref(p)} className="card" key={p.id}>
              <div className="card-tile">
                <span className="initial">{p.city.charAt(0)}</span>
                {p.property_type && <span className="type-tag">{p.property_type}</span>}
              </div>
              <div className="card-body">
                <div className="name display">{p.name}</div>
                <div className="location">{[p.district, p.city].filter(Boolean).join(", ")}</div>
                <div className="card-meta">
                  <div className="price"><span className="amount">{p.currency} {Number(p.nightly_price).toFixed(0)}</span> / {gt("night")}</div>
                  <div className="details">
                    {p.max_guests} {Number(p.max_guests) === 1 ? gt("guest") : gt("guests")}
                    {p.bedrooms != null ? ` · ${p.bedrooms} ${Number(p.bedrooms) === 1 ? gt("bed") : gt("beds")}` : ""}
                    {p.bathrooms != null ? ` · ${p.bathrooms} ${Number(p.bathrooms) === 1 ? gt("bath") : gt("baths")}` : ""}
                  </div>
                </div>
                {p.rating != null && p.review_count != null && (
                  <div className="card-rating">★ {Number(p.rating).toFixed(1)} ({p.review_count})</div>
                )}
              </div>
            </a>
          ))}
        </div>
      )}
    </div>
  );
}
