"use client";

import { useState } from "react";
import { usePathname } from "next/navigation";
import { useI18n } from "@/components/I18nProvider";

type Recommendation = {
  id: string;
  name: string;
  slug: string;
  city: string;
  district: string | null;
  propertyType: string;
  currency: string;
  nightlyPrice: number;
  maxGuests: number;
  bedrooms: number;
  bathrooms: number;
  rating: number | null;
  reviewCount: number;
};

type ConciergeResponse = {
  answer: string;
  recommendations: Recommendation[];
  followUps: string[];
};

const MAX_QUESTION_LENGTH = 600;

export function GuestConcierge() {
  const pathname = usePathname();
  const { locale, t } = useI18n();
  const [open, setOpen] = useState(false);
  const [question, setQuestion] = useState("");
  const [result, setResult] =
    useState<ConciergeResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isGuestDiscoveryPage =
    pathname === "/" ||
    pathname === "/search" ||
    pathname.startsWith("/stays/");

  if (!isGuestDiscoveryPage) {
    return null;
  }

  async function submitQuestion(
    event: React.FormEvent<HTMLFormElement>,
  ) {
    event.preventDefault();

    const trimmedQuestion = question.trim();

    if (
      trimmedQuestion.length < 2 ||
      trimmedQuestion.length > MAX_QUESTION_LENGTH ||
      loading
    ) {
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const params = new URLSearchParams(
        window.location.search,
      );
      const contextCheckIn = params.get("checkIn");
      const contextCheckOut = params.get("checkOut");
      const searchContext = {
        city: params.get("city") || undefined,
        guests: params.get("guests") || undefined,
        ...(contextCheckIn && contextCheckOut
          ? {
              checkIn: contextCheckIn,
              checkOut: contextCheckOut,
            }
          : {}),
      };

      const response = await fetch("/api/ai/concierge", {
        method: "POST",
        credentials: "include",
        cache: "no-store",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          question: trimmedQuestion,
          locale,
          ...searchContext,
        }),
      });

      const data = await response.json();

      if (!response.ok || !data.success) {
        throw new Error(
          data.error?.message ||
            t("conciergeError"),
        );
      }

      setResult({
        answer: data.answer,
        recommendations: Array.isArray(data.recommendations)
          ? data.recommendations
          : [],
        followUps: Array.isArray(data.followUps)
          ? data.followUps
          : [],
      });
    } catch (requestError) {
      setResult(null);
      setError(
        requestError instanceof Error &&
          requestError.message
          ? requestError.message
          : t("conciergeError"),
      );
    } finally {
      setLoading(false);
    }
  }

  function formatPrice(
    amount: number,
    currency: string,
  ) {
    try {
      return new Intl.NumberFormat(locale, {
        style: "currency",
        currency,
        maximumFractionDigits: 0,
      }).format(amount);
    } catch {
      return currency + " " + amount;
    }
  }

  return (
    <div className="guest-concierge">
      {!open && (
        <button
          type="button"
          className="concierge-launch"
          onClick={() => setOpen(true)}
          aria-expanded="false"
          aria-controls="host-concierge-panel"
        >
          <span aria-hidden="true">{"\u2726"}</span>
          {t("conciergeButton")}
        </button>
      )}

      {open && (
        <section
          id="host-concierge-panel"
          className="concierge-panel"
          role="dialog"
          aria-modal="false"
          aria-labelledby="host-concierge-title"
        >
          <header className="concierge-header">
            <div>
              <div className="concierge-eyebrow">
                HOST
              </div>
              <h2 id="host-concierge-title">
                {t("conciergeTitle")}
              </h2>
            </div>

            <button
              type="button"
              className="concierge-close"
              onClick={() => setOpen(false)}
              aria-label={t("conciergeClose")}
            >
              {"\u00d7"}
            </button>
          </header>

          <div className="concierge-content">
            {!result && !error && (
              <p className="concierge-welcome">
                {t("conciergeWelcome")}
              </p>
            )}

            {result && (
              <div
                className="concierge-result"
                aria-live="polite"
              >
                <p className="concierge-answer">
                  {result.answer}
                </p>

                {result.recommendations.length > 0 && (
                  <div className="concierge-properties">
                    {result.recommendations.map(
                      (property) => (
                        <a
                          key={property.id}
                          className="concierge-property"
                          href={
                            "/stays/" +
                            encodeURIComponent(property.slug)
                          }
                        >
                          <span className="property-name">
                            {property.name}
                          </span>
                          <span className="property-place">
                            {[property.district, property.city]
                              .filter(Boolean)
                              .join(", ")}
                          </span>
                          <span className="property-meta">
                            {formatPrice(
                              property.nightlyPrice,
                              property.currency,
                            )}
                            {" / "}
                            {t("conciergePerNight")}
                            {" \u00b7 "}
                            {property.maxGuests}
                            {" "}
                            {t("guests")}
                          </span>
                          <span className="property-action">
                            {t("conciergeViewStay")} {"\u2192"}
                          </span>
                        </a>
                      ),
                    )}
                  </div>
                )}

                {result.followUps.length > 0 && (
                  <div className="concierge-followups">
                    <div className="followups-label">
                      {t("conciergeSuggestions")}
                    </div>
                    {result.followUps.map((suggestion) => (
                      <button
                        type="button"
                        key={suggestion}
                        onClick={() =>
                          setQuestion(suggestion)
                        }
                      >
                        {suggestion}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}

            {error && (
              <p
                className="concierge-error"
                role="alert"
              >
                {error}
              </p>
            )}

            <form
              className="concierge-form"
              onSubmit={submitQuestion}
            >
              <label
                className="sr-only"
                htmlFor="host-concierge-question"
              >
                {t("conciergePlaceholder")}
              </label>
              <textarea
                id="host-concierge-question"
                value={question}
                maxLength={MAX_QUESTION_LENGTH}
                rows={3}
                placeholder={t("conciergePlaceholder")}
                onChange={(event) =>
                  setQuestion(event.target.value)
                }
                disabled={loading}
              />
              <div className="concierge-form-footer">
                <span>
                  {question.length}/{MAX_QUESTION_LENGTH}
                </span>
                <button
                  type="submit"
                  disabled={
                    loading ||
                    question.trim().length < 2
                  }
                >
                  {loading
                    ? t("conciergeThinking")
                    : t("conciergeSend")}
                </button>
              </div>
            </form>

            <p className="concierge-disclaimer">
              {t("conciergeDisclaimer")}
            </p>
          </div>
        </section>
      )}

      <style>{`
        .guest-concierge {
          position: fixed;
          right: 22px;
          bottom: 22px;
          z-index: 1200;
          color: #f2ecde;
          font-family: "Space Grotesk", system-ui, sans-serif;
        }

        .concierge-launch {
          display: inline-flex;
          align-items: center;
          gap: 9px;
          min-height: 48px;
          padding: 11px 17px;
          border: 1px solid #c9974b;
          border-radius: 999px;
          background: #c9974b;
          color: #14120e;
          box-shadow: 0 10px 30px rgba(0, 0, 0, 0.38);
          font: 600 14px "Space Grotesk", system-ui, sans-serif;
          cursor: pointer;
        }

        .concierge-launch span {
          font-size: 18px;
        }

        .concierge-panel {
          width: min(390px, calc(100vw - 28px));
          max-height: min(690px, calc(100vh - 36px));
          overflow-x: hidden;
          overflow-y: auto;
          border: 1px solid #3a3226;
          border-radius: 10px;
          background: #14120e;
          box-shadow: 0 18px 52px rgba(0, 0, 0, 0.58);
        }

        .concierge-header {
          position: sticky;
          top: 0;
          z-index: 2;
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 16px;
          padding: 17px 18px;
          border-bottom: 1px solid #2a251c;
          background: #14120e;
        }

        .concierge-eyebrow {
          margin-bottom: 3px;
          color: #c9974b;
          font-size: 10px;
          letter-spacing: 0.14em;
        }

        .concierge-header h2 {
          margin: 0;
          color: #f2ecde;
          font-family: "Fraunces", Georgia, serif;
          font-size: 21px;
          font-weight: 400;
        }

        .concierge-close {
          width: 36px;
          height: 36px;
          border: 1px solid #2a251c;
          border-radius: 50%;
          background: transparent;
          color: #f2ecde;
          font-size: 24px;
          line-height: 1;
          cursor: pointer;
        }

        .concierge-content {
          padding: 18px;
        }

        .concierge-welcome,
        .concierge-answer {
          margin: 0 0 16px;
          color: #d0c5b2;
          font-size: 14px;
          line-height: 1.65;
        }

        .concierge-properties {
          display: grid;
          gap: 9px;
          margin-bottom: 16px;
        }

        .concierge-property {
          display: grid;
          gap: 3px;
          padding: 13px 14px;
          border: 1px solid #2a251c;
          border-radius: 6px;
          background: #1f1b15;
          color: #f2ecde;
          text-decoration: none;
        }

        .concierge-property:hover {
          border-color: #c9974b;
        }

        .property-name {
          font-family: "Fraunces", Georgia, serif;
          font-size: 16px;
        }

        .property-place,
        .property-meta {
          color: #a79e8c;
          font-size: 11px;
        }

        .property-action {
          margin-top: 5px;
          color: #c9974b;
          font-size: 11px;
        }

        .concierge-followups {
          display: grid;
          gap: 7px;
          margin: 4px 0 16px;
        }

        .followups-label {
          color: #a79e8c;
          font-size: 11px;
          text-transform: uppercase;
          letter-spacing: 0.08em;
        }

        .concierge-followups button {
          padding: 9px 11px;
          border: 1px solid #2a251c;
          border-radius: 5px;
          background: transparent;
          color: #d0c5b2;
          font: 500 12px "Space Grotesk", system-ui, sans-serif;
          text-align: left;
          cursor: pointer;
        }

        .concierge-followups button:hover {
          border-color: #c9974b;
        }

        .concierge-error {
          margin: 0 0 14px;
          color: #e0796b;
          font-size: 13px;
          line-height: 1.5;
        }

        .concierge-form {
          display: grid;
          gap: 8px;
        }

        .concierge-form textarea {
          box-sizing: border-box;
          width: 100%;
          max-width: 100%;
          resize: vertical;
          min-height: 82px;
          padding: 11px 12px;
          border: 1px solid #2a251c;
          border-radius: 5px;
          outline: none;
          background: #0f0d0a;
          color: #f2ecde;
          font: 13px/1.5 "Space Grotesk", system-ui, sans-serif;
        }

        .concierge-form textarea:focus {
          border-color: #c9974b;
          box-shadow: 0 0 0 2px rgba(201, 151, 75, 0.17);
        }

        .concierge-form-footer {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 12px;
        }

        .concierge-form-footer > span {
          color: #746c60;
          font-size: 10px;
        }

        .concierge-form-footer button {
          min-height: 38px;
          padding: 8px 15px;
          border: 1px solid #c9974b;
          border-radius: 4px;
          background: #c9974b;
          color: #14120e;
          font: 600 12px "Space Grotesk", system-ui, sans-serif;
          cursor: pointer;
        }

        .concierge-form-footer button:disabled {
          cursor: not-allowed;
          opacity: 0.55;
        }

        .concierge-disclaimer {
          margin: 15px 0 0;
          color: #746c60;
          font-size: 10px;
          line-height: 1.5;
        }

        .sr-only {
          position: absolute;
          width: 1px;
          height: 1px;
          padding: 0;
          margin: -1px;
          overflow: hidden;
          clip: rect(0, 0, 0, 0);
          white-space: nowrap;
          border: 0;
        }

        @media (max-width: 600px) {
          .guest-concierge {
            right: 14px;
            bottom: 14px;
          }

          .concierge-panel {
            width: calc(100vw - 28px);
            max-height: calc(100vh - 28px);
          }
        }
      `}</style>
    </div>
  );
}
