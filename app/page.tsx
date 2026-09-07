"use client";

import { useEffect, useState } from "react";
import { signOut } from "next-auth/react";
import { LanguageSelector } from "@/components/LanguageSelector";
import { useI18n } from "@/components/I18nProvider";

/**
 * Fonts load via a runtime <link> tag (Next.js App Router hoists any
 * <link>/<meta> rendered in a page component up to the document <head>
 * automatically), not next/font/google's build-time self-hosting.
 * next/font/google needs to fetch the actual font files from
 * fonts.googleapis.com *during the build itself* — which failed here
 * (this sandbox's network doesn't reach Google Fonts), and more
 * importantly is a real external-network-at-build-time dependency
 * regardless of environment, the same category of fragility just fixed
 * in app/sitemap.xml/route.ts. A runtime link tag only ever needs the
 * *browser* to fetch fonts, never the build — and every font-family
 * declaration below already falls back to Georgia/system-ui, so a slow
 * or blocked font load degrades gracefully instead of breaking anything.
 */

/**
 * This repo has no design system of its own to "reuse" — no CSS files,
 * no Tailwind config, no color tokens (confirmed by inspection before
 * writing this). The checkout pages' plain system-ui styling was always
 * deliberately minimal, a smoke-test fixture rather than real brand
 * identity. What "HOST branding" actually refers to is the product's
 * established dark-editorial identity (Warm Black, Brass accent,
 * Fraunces/Space Grotesk) — applied fresh here since nothing in this
 * specific repository already expressed it.
 *
 * Deliberately static: no database calls, no auth check, no server-side
 * data fetching. This page renders identically on every request with no
 * external dependency — avoiding, on principle, the exact class of bug
 * just fixed in app/sitemap.xml/route.ts (a route that looked static but
 * secretly needed a live database at build time). A homepage has no
 * reason to carry that risk.
 */

const DESTINATIONS = [
  { city: "Lisbon", country: "Portugal", note: "Riverside light and tiled facades" },
  { city: "Copenhagen", country: "Denmark", note: "Considered design, canal-side calm" },
  { city: "Prague", country: "Czechia", note: "Spires, courtyards, old-world scale" },
  { city: "Porto", country: "Portugal", note: "Terraced hills above the Douro" },
  { city: "Barcelona", country: "Spain", note: "Modernist façades, Mediterranean light" },
  { city: "Amsterdam", country: "Netherlands", note: "Canal houses and quiet mornings" },
];

export default function HomePage() {
  const { t } = useI18n();
  const [city, setCity] = useState("");
  const [checkIn, setCheckIn] = useState("");
  const [checkOut, setCheckOut] = useState("");
  const [guests, setGuests] = useState(1);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [sessionState, setSessionState] = useState<"loading" | "signed-out" | "signed-in">("loading");
  const showStaging = process.env.NEXT_PUBLIC_SHOW_STAGING_UI === "true";

  useEffect(() => {
    fetch("/api/auth/session", { credentials: "include", cache: "no-store" })
      .then((res) => res.json())
      .then((session) => setSessionState(session?.user?.email ? "signed-in" : "signed-out"))
      .catch(() => setSessionState("signed-out"));
  }, []);

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    setSearchError(null);

    // Client-side validation only — this never decides availability or
    // pricing, it just stops an obviously malformed request before it
    // reaches the search results page. GET /api/properties enforces the
    // same checkOut > checkIn rule authoritatively on the backend either way.
    if (checkIn && !checkOut) { setSearchError(t("checkoutMissing")); return; }
    if (checkOut && !checkIn) { setSearchError(t("checkinMissing")); return; }
    if (checkIn && checkOut && checkOut <= checkIn) { setSearchError(t("datesInvalid")); return; }
    if (guests < 1) { setSearchError(t("guestInvalid")); return; }

    const params = new URLSearchParams();
    if (city.trim()) params.set("city", city.trim());
    if (checkIn) params.set("checkIn", checkIn);
    if (checkOut) params.set("checkOut", checkOut);
    if (guests > 1) params.set("guests", String(guests));

    window.location.href = `/search${params.toString() ? `?${params.toString()}` : ""}`;
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
          --ink: #14120E;
          --graphite: #1F1B15;
          --stone: #2A251C;
          --ivory: #F2ECDE;
          --warm-grey: #A79E8C;
          --brass: #C9974B;
          font-family: var(--font-body), system-ui, sans-serif;
          background: var(--ink);
          color: var(--ivory);
          min-height: 100vh;
        }
        .page-root * { box-sizing: border-box; }
        .display { font-family: var(--font-display), Georgia, serif; }
        .eyebrow { font-family: var(--font-body), system-ui, sans-serif; font-size: 11px; letter-spacing: 0.14em; text-transform: uppercase; color: var(--brass); }

        .nav { display: flex; align-items: center; justify-content: space-between; padding: 24px 28px; border-bottom: 1px solid var(--stone); }
        .wordmark { font-family: var(--font-display), Georgia, serif; font-size: 20px; letter-spacing: 0.02em; color: var(--ivory); }
        .nav-actions { display: flex; align-items: center; gap: 10px; }
        .nav-link, .nav-button { color: var(--ivory); border: 1px solid var(--stone); border-radius: 4px; padding: 9px 13px; background: transparent; font-family: var(--font-body); font-size: 12px; text-decoration: none; cursor: pointer; }
        .nav-link.primary { background: var(--brass); border-color: var(--brass); color: var(--ink); }
        .nav-link:hover, .nav-button:hover { border-color: var(--brass); }
        .staging-pill { font-family: var(--font-body), system-ui, sans-serif; font-size: 10px; letter-spacing: 0.1em; text-transform: uppercase; color: var(--warm-grey); border: 1px solid var(--stone); border-radius: 999px; padding: 6px 12px; }

        .hero { max-width: 880px; margin: 0 auto; padding: 88px 28px 64px; text-align: center; }
        .hero h1 { font-size: 52px; line-height: 1.08; font-weight: 400; margin: 20px 0 22px; }
        .hero h1 em { font-style: italic; color: var(--brass); }
        .hero p { font-size: 17px; line-height: 1.6; color: var(--warm-grey); max-width: 540px; margin: 0 auto 36px; }
        .cta-row { display: flex; gap: 14px; justify-content: center; flex-wrap: wrap; }
        .btn-primary { background: var(--brass); color: var(--ink); border: none; padding: 14px 26px; border-radius: 4px; font-family: var(--font-body); font-size: 14px; font-weight: 500; cursor: pointer; text-decoration: none; display: inline-block; }
        .btn-secondary { background: transparent; color: var(--ivory); border: 1px solid var(--stone); padding: 14px 26px; border-radius: 4px; font-family: var(--font-body); font-size: 14px; cursor: pointer; text-decoration: none; display: inline-block; }

        .search-panel { background: var(--graphite); border: 1px solid var(--stone); border-radius: 8px; padding: 22px; margin: 0 0 28px; text-align: left; }
        .search-fields { display: grid; grid-template-columns: 1.6fr 1fr 1fr 0.8fr auto; gap: 14px; align-items: end; }
        .search-field label { display: block; font-size: 10px; letter-spacing: 0.1em; text-transform: uppercase; color: var(--warm-grey); margin-bottom: 6px; }
        .search-field input { width: 100%; background: var(--ink); border: 1px solid var(--stone); color: var(--ivory); padding: 11px 12px; border-radius: 4px; font-family: var(--font-body); font-size: 14px; color-scheme: dark; }
        .search-field input:focus { outline: none; border-color: var(--brass); }
        .search-submit { white-space: nowrap; padding: 12px 24px; }
        .search-error { margin-top: 14px; font-size: 13px; color: #E0796B; }
        @media (max-width: 820px) {
          .search-fields { grid-template-columns: 1fr 1fr; }
          .search-field-guests { grid-column: span 1; }
          .search-submit { grid-column: 1 / -1; }
        }

        .section { max-width: 1080px; margin: 0 auto; padding: 40px 28px 96px; }
        .section-head { text-align: center; margin-bottom: 40px; }
        .section-head h2 { font-size: 28px; font-weight: 400; margin: 10px 0 0; }
        .grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 18px; }
        .city-card { border: 1px solid var(--stone); border-radius: 6px; overflow: hidden; background: var(--graphite); }
        .city-swatch { height: 120px; background: linear-gradient(135deg, var(--stone) 0%, var(--ink) 100%); position: relative; }
        .city-swatch::after { content: ""; position: absolute; inset: 0; background: linear-gradient(180deg, transparent 40%, rgba(201,151,75,0.12) 100%); }
        .city-body { padding: 16px 18px 20px; }
        .city-body .city-name { font-family: var(--font-display), Georgia, serif; font-size: 19px; margin-bottom: 2px; }
        .city-body .city-country { font-size: 12px; color: var(--warm-grey); margin-bottom: 10px; }
        .city-body .city-note { font-size: 13px; color: var(--warm-grey); line-height: 1.5; }

        .footer-note { text-align: center; padding: 32px 28px 56px; font-size: 12px; color: var(--warm-grey); border-top: 1px solid var(--stone); }

        @media (max-width: 720px) {
          .hero { padding: 56px 20px 48px; }
          .hero h1 { font-size: 34px; }
          .hero p { font-size: 15px; }
          .grid { grid-template-columns: 1fr; }
          .nav { padding: 18px 20px; }
          .staging-pill { display: none; }
          .nav-actions { gap: 6px; }
          .nav-link, .nav-button { padding: 8px 10px; }
        }
        @media (min-width: 721px) and (max-width: 980px) {
          .grid { grid-template-columns: repeat(2, 1fr); }
        }
      `}</style>

      <nav className="nav">
        <a href="/" className="wordmark" style={{ textDecoration: "none" }}>HOST</a>
        <div className="nav-actions" aria-label="Account navigation">
          {showStaging && <div className="staging-pill">Staging · Test deployment</div>}
          <LanguageSelector compact />
          {sessionState === "signed-out" && (
            <>
              <a href="/login" className="nav-link">{t("login")}</a>
              <a href="/login?mode=register" className="nav-link primary">{t("signup")}</a>
            </>
          )}
          {sessionState === "signed-in" && (
            <>
              <a href="/trips" className="nav-link">{t("trips")}</a>
              <a href="/account" className="nav-link">{t("account")}</a>
              <button type="button" className="nav-button" onClick={() => signOut({ callbackUrl: "/" })}>{t("logout")}</button>
            </>
          )}
        </div>
      </nav>

      <section className="hero">
        <div className="eyebrow">{t("eyebrow")}</div>
        <h1 className="display">
          {t("heroLead")} <em>{t("heroEmphasis")}</em> {t("heroEnd")}
        </h1>
        <p>
          {t("heroBody")}
        </p>

        <form className="search-panel" onSubmit={handleSearch}>
          <div className="search-fields">
            <div className="search-field">
              <label htmlFor="search-city">{t("destination")}</label>
              <input id="search-city" type="text" placeholder="Lisbon, Berlin, Prague…" value={city} onChange={(e) => setCity(e.target.value)} />
            </div>
            <div className="search-field">
              <label htmlFor="search-checkin">{t("checkin")}</label>
              <input id="search-checkin" type="date" value={checkIn} onChange={(e) => setCheckIn(e.target.value)} />
            </div>
            <div className="search-field">
              <label htmlFor="search-checkout">{t("checkout")}</label>
              <input id="search-checkout" type="date" value={checkOut} onChange={(e) => setCheckOut(e.target.value)} />
            </div>
            <div className="search-field search-field-guests">
              <label htmlFor="search-guests">{t("guests")}</label>
              <input id="search-guests" type="number" min={1} max={50} value={guests} onChange={(e) => setGuests(Math.max(1, Number(e.target.value) || 1))} />
            </div>
            <button type="submit" className="btn-primary search-submit">{t("search")}</button>
          </div>
          {searchError && <div className="search-error">{searchError}</div>}
        </form>

        <div className="cta-row">
          <a href="#destinations" className="btn-secondary">{t("browse")}</a>
          {showStaging && <a href="https://github.com/christopherdavis1486-max/HOST" className="btn-secondary" target="_blank" rel="noopener noreferrer">
            View staging build on GitHub
          </a>}
        </div>
      </section>

      <section className="section" id="destinations">
        <div className="section-head">
          <div className="eyebrow">{t("where")}</div>
          <h2 className="display">{t("firstLook")}</h2>
        </div>
        <div className="grid">
          {DESTINATIONS.map((d) => (
            <div className="city-card" key={d.city}>
              <div className="city-swatch" />
              <div className="city-body">
                <div className="city-name display">{d.city}</div>
                <div className="city-country">{d.country}</div>
                <div className="city-note">{d.note}</div>
              </div>
            </div>
          ))}
        </div>
      </section>

      <div className="footer-note">
        This is a staging deployment of HOST used for integration testing — booking data, payments, and
        listings are in Stripe Test Mode and are not real transactions.
      </div>
    </div>
  );
}
