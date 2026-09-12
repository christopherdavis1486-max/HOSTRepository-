"use client";

import { useEffect, useState } from "react";
import { CustomerNav } from "@/components/CustomerNav";
import { useGuestI18n } from "@/lib/i18n/useGuestI18n";

/**
 * Calls the public GET /api/properties route directly.
 *
 * Search parameters are read from window.location.search on mount. This
 * avoids useSearchParams requiring a Suspense boundary on this static
 * page while preserving the visitor's city, dates and guest count.
 *
 * Property cards use the safe cover-image projection returned by the
 * API. If a listing has no image, the established typographic gradient
 * tile remains as an intentional fallback.
 */

type CoverImage = {
  id: string;
  url: string;
  altText: string | null;
  width: number | null;
  height: number | null;
};

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
  coverImage: CoverImage | null;
};

type State =
  | "loading"
  | "error"
  | "invalid"
  | "results";

export default function SearchPage() {
  const { gt } = useGuestI18n();

  const [properties, setProperties] = useState<
    Property[]
  >([]);
  const [state, setState] =
    useState<State>("loading");
  const [errorMessage, setErrorMessage] = useState<
    string | null
  >(null);
  const [criteria, setCriteria] = useState<{
    city?: string;
    checkIn?: string;
    checkOut?: string;
    guests?: string;
  }>({});

  useEffect(() => {
    const params = new URLSearchParams(
      window.location.search
    );

    const city = params.get("city") ?? undefined;
    const checkIn =
      params.get("checkIn") ?? undefined;
    const checkOut =
      params.get("checkOut") ?? undefined;
    const guests =
      params.get("guests") ?? undefined;

    setCriteria({
      city,
      checkIn,
      checkOut,
      guests,
    });

    fetch(`/api/properties?${params.toString()}`)
      .then(async (response) => {
        const data = await response.json();

        if (response.status === 400) {
          setErrorMessage(
            data.error?.message ??
              gt("invalidSearch")
          );
          setState("invalid");
          return;
        }

        if (!data.success) {
          setState("error");
          return;
        }

        setProperties(data.properties);
        setState("results");
      })
      .catch(() => setState("error"));
  }, [gt]);

  const detailHref = (property: Property) => {
    const params = new URLSearchParams();

    if (criteria.checkIn) {
      params.set("checkIn", criteria.checkIn);
    }

    if (criteria.checkOut) {
      params.set("checkOut", criteria.checkOut);
    }

    if (criteria.guests) {
      params.set("guests", criteria.guests);
    }

    const query = params.toString();

    return `/stays/${
      property.slug ?? property.id
    }${query ? `?${query}` : ""}`;
  };

  const criteriaLabel = [
    criteria.city,
    criteria.checkIn && criteria.checkOut
      ? `${criteria.checkIn} → ${criteria.checkOut}`
      : null,
    criteria.guests
      ? `${criteria.guests} ${
          criteria.guests === "1"
            ? gt("guest")
            : gt("guests")
        }`
      : null,
  ]
    .filter(Boolean)
    .join(" · ");

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
          --error: #E0796B;
          font-family: var(--font-body), system-ui, sans-serif;
          background: var(--ink);
          color: var(--ivory);
          min-height: 100vh;
        }

        .page-root * {
          box-sizing: border-box;
        }

        .display {
          font-family: var(--font-display), Georgia, serif;
        }

        .header {
          max-width: 1080px;
          margin: 0 auto;
          padding: 32px 28px;
        }

        .header h1 {
          font-size: 28px;
          font-weight: 400;
          margin: 0 0 6px;
        }

        .header .criteria {
          color: var(--warm-grey);
          font-size: 14px;
        }

        .header .criteria a {
          color: var(--brass);
          text-decoration: none;
          margin-left: 10px;
        }

        .state-block {
          max-width: 1080px;
          margin: 60px auto;
          padding: 0 28px;
          text-align: center;
          color: var(--warm-grey);
        }

        .error-box {
          display: inline-block;
          padding: 14px 18px;
          border: 1px solid var(--error);
          border-radius: 6px;
          background: rgba(224, 121, 107, 0.12);
          color: var(--error);
        }

        .grid {
          max-width: 1080px;
          margin: 0 auto;
          padding: 0 28px 80px;
          display: grid;
          grid-template-columns: repeat(3, 1fr);
          gap: 20px;
        }

        .card {
          display: block;
          overflow: hidden;
          border: 1px solid var(--stone);
          border-radius: 8px;
          background: var(--graphite);
          color: inherit;
          text-decoration: none;
          transition:
            border-color 0.15s,
            transform 0.15s;
        }

        .card:hover {
          border-color: var(--brass);
          transform: translateY(-2px);
        }

        .card-tile {
          height: 180px;
          position: relative;
          display: flex;
          align-items: flex-end;
          overflow: hidden;
          padding: 14px;
          background:
            linear-gradient(
              135deg,
              var(--stone) 0%,
              var(--ink) 100%
            );
        }

        .card-tile::after {
          content: "";
          position: absolute;
          inset: 0;
          background:
            linear-gradient(
              180deg,
              transparent 35%,
              rgba(20, 18, 14, 0.7) 100%
            );
          pointer-events: none;
        }

        .card-image {
          position: absolute;
          inset: 0;
          width: 100%;
          height: 100%;
          object-fit: cover;
        }

        .card-tile .initial {
          position: absolute;
          top: 10px;
          left: 16px;
          font-family: var(--font-display), Georgia, serif;
          font-size: 46px;
          color: rgba(242, 236, 222, 0.15);
        }

        .card-tile .type-tag {
          position: relative;
          z-index: 1;
          padding: 5px 8px;
          border-radius: 999px;
          background: rgba(20, 18, 14, 0.75);
          color: var(--brass);
          font-size: 11px;
          letter-spacing: 0.08em;
          text-transform: uppercase;
        }

        .card-body {
          padding: 16px 18px 20px;
        }

        .card-body .name {
          margin-bottom: 4px;
          font-family: var(--font-display), Georgia, serif;
          font-size: 17px;
        }

        .card-body .location {
          margin-bottom: 10px;
          color: var(--warm-grey);
          font-size: 13px;
        }

        .card-meta {
          display: flex;
          justify-content: space-between;
          align-items: center;
          gap: 12px;
          font-size: 13px;
        }

        .card-meta .price {
          color: var(--ivory);
          white-space: nowrap;
        }

        .card-meta .amount {
          color: var(--brass);
          font-family: var(--font-display), Georgia, serif;
          font-size: 16px;
        }

        .card-meta .details {
          color: var(--warm-grey);
          text-align: right;
        }

        .card-rating {
          margin-top: 6px;
          color: var(--warm-grey);
          font-size: 12px;
        }

        @media (max-width: 900px) {
          .grid {
            grid-template-columns: repeat(2, 1fr);
          }
        }

        @media (max-width: 620px) {
          .grid {
            grid-template-columns: 1fr;
          }
        }
      `}</style>

      <CustomerNav />

      <div className="header">
        <h1 className="display">{gt("stays")}</h1>

        {criteriaLabel && (
          <div className="criteria">
            {criteriaLabel}
            <a href="/">{gt("changeSearch")}</a>
          </div>
        )}
      </div>

      {state === "loading" && (
        <div className="state-block">
          {gt("searching")}
        </div>
      )}

      {state === "invalid" && (
        <div className="state-block">
          <div className="error-box">
            {errorMessage}
          </div>
        </div>
      )}

      {state === "error" && (
        <div className="state-block">
          <div className="error-box">
            {gt("loadStaysError")}
          </div>
        </div>
      )}

      {state === "results" &&
        properties.length === 0 && (
          <div className="state-block">
            {gt("noStays")}
          </div>
        )}

      {state === "results" &&
        properties.length > 0 && (
          <div className="grid">
            {properties.map((property) => (
              <a
                href={detailHref(property)}
                className="card"
                key={property.id}
              >
                <div className="card-tile">
                  {property.coverImage ? (
                    <img
                      className="card-image"
                      src={property.coverImage.url}
                      alt={
                        property.coverImage.altText?.trim() ||
                        `${property.name} property`
                      }
                      width={
                        property.coverImage.width ??
                        undefined
                      }
                      height={
                        property.coverImage.height ??
                        undefined
                      }
                    />
                  ) : (
                    <span className="initial">
                      {property.city.charAt(0)}
                    </span>
                  )}

                  {property.property_type && (
                    <span className="type-tag">
                      {property.property_type}
                    </span>
                  )}
                </div>

                <div className="card-body">
                  <div className="name display">
                    {property.name}
                  </div>

                  <div className="location">
                    {[
                      property.district,
                      property.city,
                    ]
                      .filter(Boolean)
                      .join(", ")}
                  </div>

                  <div className="card-meta">
                    <div className="price">
                      <span className="amount">
                        {property.currency}{" "}
                        {Number(
                          property.nightly_price
                        ).toFixed(0)}
                      </span>
                      {" / "}
                      {gt("night")}
                    </div>

                    <div className="details">
                      {property.max_guests}{" "}
                      {Number(
                        property.max_guests
                      ) === 1
                        ? gt("guest")
                        : gt("guests")}

                      {property.bedrooms != null
                        ? ` · ${property.bedrooms} ${
                            Number(
                              property.bedrooms
                            ) === 1
                              ? gt("bed")
                              : gt("beds")
                          }`
                        : ""}

                      {property.bathrooms != null
                        ? ` · ${property.bathrooms} ${
                            Number(
                              property.bathrooms
                            ) === 1
                              ? gt("bath")
                              : gt("baths")
                          }`
                        : ""}
                    </div>
                  </div>

                  {property.rating != null &&
                    property.review_count != null && (
                      <div className="card-rating">
                        ★{" "}
                        {Number(
                          property.rating
                        ).toFixed(1)}
                        {" ("}
                        {property.review_count}
                        {")"}
                      </div>
                    )}
                </div>
              </a>
            ))}
          </div>
        )}
    </div>
  );
}