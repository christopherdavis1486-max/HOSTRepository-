"use client";

import { useEffect, useState } from "react";
import { signOut } from "next-auth/react";
import { LanguageSelector } from "@/components/LanguageSelector";
import { HomepagePropertyMap } from "@/components/HomepagePropertyMap";
import { useI18n } from "@/components/I18nProvider";

const DESTINATIONS = [
  {
    city: "Lisbon",
    country: "Portugal",
    note: "Riverside light and tiled facades",
  },
  {
    city: "Copenhagen",
    country: "Denmark",
    note: "Considered design, canal-side calm",
  },
  {
    city: "Prague",
    country: "Czechia",
    note: "Spires, courtyards, old-world scale",
  },
  {
    city: "Porto",
    country: "Portugal",
    note: "Terraced hills above the Douro",
  },
  {
    city: "Barcelona",
    country: "Spain",
    note: "Modernist façades, Mediterranean light",
  },
  {
    city: "Amsterdam",
    country: "Netherlands",
    note: "Canal houses and quiet mornings",
  },
];

type HomeSessionState = {
  signedIn: boolean;
  isHost: boolean;
};

export default function HomePage() {
  const { t } = useI18n();
  const [city, setCity] = useState("");
  const [checkIn, setCheckIn] = useState("");
  const [checkOut, setCheckOut] = useState("");
  const [guests, setGuests] = useState(1);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [sessionState, setSessionState] =
    useState<HomeSessionState | null>(null);

  const showStaging =
    process.env.NEXT_PUBLIC_SHOW_STAGING_UI === "true";

  useEffect(() => {
    fetch("/api/auth/session", {
      credentials: "include",
      cache: "no-store",
    })
      .then((response) => response.json())
      .then((session) =>
        setSessionState({
          signedIn: Boolean(session?.user?.email),
          isHost:
            Array.isArray(session?.user?.roles) &&
            session.user.roles.includes("host"),
        }),
      )
      .catch(() =>
        setSessionState({
          signedIn: false,
          isHost: false,
        }),
      );
  }, []);

  function handleSearch(event: React.FormEvent) {
    event.preventDefault();
    setSearchError(null);

    if (checkIn && !checkOut) {
      setSearchError(t("checkoutMissing"));
      return;
    }

    if (checkOut && !checkIn) {
      setSearchError(t("checkinMissing"));
      return;
    }

    if (checkIn && checkOut && checkOut <= checkIn) {
      setSearchError(t("datesInvalid"));
      return;
    }

    if (guests < 1) {
      setSearchError(t("guestInvalid"));
      return;
    }

    const params = new URLSearchParams();

    if (city.trim()) {
      params.set("city", city.trim());
    }

    if (checkIn) {
      params.set("checkIn", checkIn);
    }

    if (checkOut) {
      params.set("checkOut", checkOut);
    }

    if (guests > 1) {
      params.set("guests", String(guests));
    }

    const query = params.toString();
    window.location.href = `/search${query ? `?${query}` : ""}`;
  }

  return (
    <div className="page-root">
      <link
        rel="stylesheet"
        href="https://fonts.googleapis.com/css2?family=Fraunces:ital,wght@0,400;0,500;1,400;1,500&family=Space+Grotesk:wght@400;500&display=swap"
      />

      <style>{`
        .page-root {
          --font-display: "Fraunces", Georgia, serif;
          --font-body: "Space Grotesk", system-ui, sans-serif;
          --ink: #14120e;
          --graphite: #1f1b15;
          --stone: #2a251c;
          --ivory: #f2ecde;
          --warm-grey: #a79e8c;
          --brass: #c9974b;
          min-height: 100vh;
          background: var(--ink);
          color: var(--ivory);
          font-family: var(--font-body);
        }

        .page-root * {
          box-sizing: border-box;
        }

        .display {
          font-family: var(--font-display);
        }

        .eyebrow {
          color: var(--brass);
          font-size: 11px;
          letter-spacing: 0.14em;
          text-transform: uppercase;
        }

        .nav {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 18px;
          padding: 24px 28px;
          border-bottom: 1px solid var(--stone);
        }

        .wordmark {
          color: var(--ivory);
          font-family: var(--font-display);
          font-size: 20px;
          letter-spacing: 0.02em;
          text-decoration: none;
        }

        .nav-actions {
          display: flex;
          align-items: center;
          justify-content: flex-end;
          gap: 10px;
          flex-wrap: wrap;
        }

        .nav-link,
        .nav-button {
          padding: 9px 13px;
          border: 1px solid var(--stone);
          border-radius: 4px;
          background: transparent;
          color: var(--ivory);
          font-family: var(--font-body);
          font-size: 12px;
          text-decoration: none;
          cursor: pointer;
        }

        .nav-link.primary {
          border-color: var(--brass);
          background: var(--brass);
          color: var(--ink);
        }

        .nav-link:hover,
        .nav-button:hover {
          border-color: var(--brass);
        }

        .nav-link:focus-visible,
        .nav-button:focus-visible,
        .wordmark:focus-visible,
        .btn-primary:focus-visible,
        .btn-secondary:focus-visible {
          outline: 2px solid var(--brass);
          outline-offset: 3px;
        }

        .staging-pill {
          padding: 6px 12px;
          border: 1px solid var(--stone);
          border-radius: 999px;
          color: var(--warm-grey);
          font-size: 10px;
          letter-spacing: 0.1em;
          text-transform: uppercase;
        }

        .hero {
          max-width: 880px;
          margin: 0 auto;
          padding: 88px 28px 64px;
          text-align: center;
        }

        .hero h1 {
          margin: 20px 0 22px;
          font-size: 52px;
          font-weight: 400;
          line-height: 1.08;
        }

        .hero h1 em {
          color: var(--brass);
          font-style: italic;
        }

        .hero > p {
          max-width: 540px;
          margin: 0 auto 36px;
          color: var(--warm-grey);
          font-size: 17px;
          line-height: 1.6;
        }

        .search-panel {
          margin: 0 0 28px;
          padding: 22px;
          border: 1px solid var(--stone);
          border-radius: 8px;
          background: var(--graphite);
          text-align: left;
        }

        .search-fields {
          display: grid;
          grid-template-columns: 1.6fr 1fr 1fr 0.8fr auto;
          gap: 14px;
          align-items: end;
        }

        .search-field label {
          display: block;
          margin-bottom: 6px;
          color: var(--warm-grey);
          font-size: 10px;
          letter-spacing: 0.1em;
          text-transform: uppercase;
        }

        .search-field input {
          width: 100%;
          padding: 11px 12px;
          border: 1px solid var(--stone);
          border-radius: 4px;
          background: var(--ink);
          color: var(--ivory);
          color-scheme: dark;
          font-family: var(--font-body);
          font-size: 14px;
        }

        .search-field input:focus {
          border-color: var(--brass);
          outline: none;
        }

        .search-submit {
          padding: 12px 24px;
          white-space: nowrap;
        }

        .search-error {
          margin-top: 14px;
          color: #e0796b;
          font-size: 13px;
        }

        .cta-row {
          display: flex;
          justify-content: center;
          gap: 14px;
          flex-wrap: wrap;
        }

        .btn-primary,
        .btn-secondary {
          display: inline-block;
          padding: 14px 26px;
          border-radius: 4px;
          font-family: var(--font-body);
          font-size: 14px;
          font-weight: 500;
          text-decoration: none;
          cursor: pointer;
        }

        .btn-primary {
          border: 1px solid var(--brass);
          background: var(--brass);
          color: var(--ink);
        }

        .btn-secondary {
          border: 1px solid var(--stone);
          background: transparent;
          color: var(--ivory);
        }

        .btn-secondary:hover {
          border-color: var(--brass);
        }

        .section {
          max-width: 1080px;
          margin: 0 auto;
          padding: 40px 28px 96px;
        }

        .section-head {
          margin-bottom: 40px;
          text-align: center;
        }

        .section-head h2 {
          margin: 10px 0 0;
          font-size: 28px;
          font-weight: 400;
        }

        .grid {
          display: grid;
          grid-template-columns: repeat(3, 1fr);
          gap: 18px;
        }

        .city-card {
          overflow: hidden;
          border: 1px solid var(--stone);
          border-radius: 6px;
          background: var(--graphite);
        }

        .city-swatch {
          position: relative;
          height: 120px;
          background:
            linear-gradient(
              135deg,
              var(--stone) 0%,
              var(--ink) 100%
            );
        }

        .city-swatch::after {
          position: absolute;
          inset: 0;
          background:
            linear-gradient(
              180deg,
              transparent 40%,
              rgba(201, 151, 75, 0.12) 100%
            );
          content: "";
        }

        .city-body {
          padding: 16px 18px 20px;
        }

        .city-name {
          margin-bottom: 2px;
          font-size: 19px;
        }

        .city-country {
          margin-bottom: 10px;
          color: var(--warm-grey);
          font-size: 12px;
        }

        .city-note {
          color: var(--warm-grey);
          font-size: 13px;
          line-height: 1.5;
        }

        .footer-note {
          padding: 32px 28px 56px;
          border-top: 1px solid var(--stone);
          color: var(--warm-grey);
          font-size: 12px;
          line-height: 1.6;
          text-align: center;
        }

        .footer-note p {
          margin: 0 0 12px;
        }

        .footer-note a {
          color: var(--brass);
        }

        @media (max-width: 820px) {
          .search-fields {
            grid-template-columns: 1fr 1fr;
          }

          .search-submit {
            grid-column: 1 / -1;
          }
        }

        @media (max-width: 720px) {
          .hero {
            padding: 56px 20px 48px;
          }

          .hero h1 {
            font-size: 34px;
          }

          .hero > p {
            font-size: 15px;
          }

          .grid {
            grid-template-columns: 1fr;
          }

          .nav {
            flex-direction: column;
            align-items: stretch;
            gap: 14px;
            padding: 18px 20px;
          }

          .wordmark {
            align-self: center;
          }

          .nav-actions {
            display: grid;
            grid-template-columns: repeat(2, minmax(0, 1fr));
            gap: 8px;
            width: 100%;
          }

          .nav-actions > *,
          .nav-link,
          .nav-button {
            width: 100%;
            min-width: 0;
          }

          .nav-link,
          .nav-button {
            display: flex;
            align-items: center;
            justify-content: center;
            min-height: 42px;
            padding: 8px;
            text-align: center;
          }

          .nav-actions :global(.language-selector),
          .nav-actions :global(.language-selector select) {
            width: 100%;
            max-width: none;
          }

          .staging-pill {
            display: none;
          }
        }

        @media (min-width: 721px) and (max-width: 980px) {
          .grid {
            grid-template-columns: repeat(2, 1fr);
          }
        }
      `}</style>

      <nav className="nav">
        <a href="/" className="wordmark">
          HOST
        </a>

        <div className="nav-actions" aria-label="Account navigation">
          {showStaging && (
            <div className="staging-pill">
              Staging · Test deployment
            </div>
          )}

          <LanguageSelector compact />

          {sessionState && !sessionState.isHost && (
            <a href="/host-with-us" className="nav-link primary">
              {t("listProperty")}
            </a>
          )}

          {sessionState?.signedIn === false && (
            <>
              <a href="/login" className="nav-link">
                {t("login")}
              </a>

              <a href="/login?mode=register" className="nav-link">
                {t("signup")}
              </a>
            </>
          )}

          {sessionState?.signedIn === true && (
            <>
              <a href="/trips" className="nav-link">
                {t("trips")}
              </a>

              <a href="/favourites" className="nav-link">
                {t("savedStays")}
              </a>

              {sessionState.isHost && (
                <a
                  href="/host/dashboard"
                  className="nav-link primary"
                >
                  {t("hostWorkspace")}
                </a>
              )}

              <a href="/account" className="nav-link">
                {t("account")}
              </a>

              <button
                type="button"
                className="nav-button"
                onClick={() => signOut({ callbackUrl: "/" })}
              >
                {t("logout")}
              </button>
            </>
          )}
        </div>
      </nav>

      <section className="hero">
        <div className="eyebrow">{t("eyebrow")}</div>

        <h1 className="display">
          {t("heroLead")}{" "}
          <em>{t("heroEmphasis")}</em>{" "}
          {t("heroEnd")}
        </h1>

        <p>{t("heroBody")}</p>

        <form className="search-panel" onSubmit={handleSearch}>
          <div className="search-fields">
            <div className="search-field">
              <label htmlFor="search-city">
                {t("destination")}
              </label>

              <input
                id="search-city"
                type="text"
                placeholder="Lisbon, Berlin, Prague…"
                value={city}
                onChange={(event) => setCity(event.target.value)}
              />
            </div>

            <div className="search-field">
              <label htmlFor="search-checkin">
                {t("checkin")}
              </label>

              <input
                id="search-checkin"
                type="date"
                value={checkIn}
                onChange={(event) => setCheckIn(event.target.value)}
              />
            </div>

            <div className="search-field">
              <label htmlFor="search-checkout">
                {t("checkout")}
              </label>

              <input
                id="search-checkout"
                type="date"
                value={checkOut}
                onChange={(event) => setCheckOut(event.target.value)}
              />
            </div>

            <div className="search-field search-field-guests">
              <label htmlFor="search-guests">
                {t("guests")}
              </label>

              <input
                id="search-guests"
                type="number"
                min={1}
                max={50}
                value={guests}
                onChange={(event) =>
                  setGuests(
                    Math.max(
                      1,
                      Number(event.target.value) || 1,
                    ),
                  )
                }
              />
            </div>

            <button
              type="submit"
              className="btn-primary search-submit"
            >
              {t("search")}
            </button>
          </div>

          {searchError && (
            <div className="search-error" role="alert">
              {searchError}
            </div>
          )}
        </form>

        <div className="cta-row">
          <a href="#destinations" className="btn-secondary">
            {t("browse")}
          </a>

          <a href="/host-with-us" className="btn-secondary">
            {t("listProperty")}
          </a>

          {showStaging && (
            <a
              href="https://github.com/christopherdavis1486-max/HOST"
              className="btn-secondary"
              target="_blank"
              rel="noopener noreferrer"
            >
              View staging build on GitHub
            </a>
          )}
        </div>
      </section>

      <HomepagePropertyMap
        eyebrow={t("mapEyebrow")}
        heading={t("mapHeading")}
        privacyMessage={t("mapPrivacy")}
        loadingMessage={t("mapLoading")}
      />

      <section className="section" id="destinations">
        <div className="section-head">
          <div className="eyebrow">{t("where")}</div>

          <h2 className="display">
            {t("firstLook")}
          </h2>
        </div>

        <div className="grid">
          {DESTINATIONS.map((destination) => (
            <div
              className="city-card"
              key={destination.city}
            >
              <div className="city-swatch" />

              <div className="city-body">
                <div className="city-name display">
                  {destination.city}
                </div>

                <div className="city-country">
                  {destination.country}
                </div>

                <div className="city-note">
                  {destination.note}
                </div>
              </div>
            </div>
          ))}
        </div>
      </section>

      <footer className="footer-note">
        <p>
          This is a staging deployment of HOST used for integration
          testing — booking data, payments and listings are in Stripe
          Test Mode and are not real transactions.
        </p>

        <a href="/host-with-us">
          {t("listProperty")}
        </a>
      </footer>
    </div>
  );
}