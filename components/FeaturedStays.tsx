"use client";

import { useEffect, useState } from "react";

type FeaturedProperty = {
  id: string;
  name: string;
  slug: string | null;
  city: string;
  country_code?: string | null;
  nightly_price: number | string;
  currency: string;
  rating: number | string | null;
  review_count: number | string | null;
  max_guests: number | string;
  coverImage: {
    url: string;
    altText?: string | null;
  } | null;
};

function money(value: number | string, currency: string) {
  const amount = Number(value);

  if (!Number.isFinite(amount)) return "";

  return new Intl.NumberFormat("en-GB", {
    style: "currency",
    currency: currency || "GBP",
    maximumFractionDigits: 0,
  }).format(amount);
}

export function FeaturedStays() {
  const [properties, setProperties] = useState<FeaturedProperty[]>([]);

  useEffect(() => {
    const controller = new AbortController();

    fetch("/api/properties", {
      cache: "no-store",
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) throw new Error("Unable to load featured stays.");

        const data = await response.json();

        if (data.success && Array.isArray(data.properties)) {
          setProperties(
            data.properties
              .filter((property: FeaturedProperty) => property.slug)
              .slice(0, 4),
          );
        }
      })
      .catch((error: unknown) => {
        if (
          !(error instanceof DOMException && error.name === "AbortError")
        ) {
          setProperties([]);
        }
      });

    return () => controller.abort();
  }, []);

  if (properties.length === 0) return null;

  const lovedByGuests =
    properties.length > 0 &&
    properties.every(
      (property) =>
        Number(property.rating) >= 4.8 &&
        Number(property.review_count) >= 10,
    );

  return (
    <section className="featured-stays" aria-labelledby="featured-stays-title">
      <div className="featured-stays-head">
        <div>
          <div className="eyebrow">Selected for HOST</div>
          <h2 id="featured-stays-title" className="display">
            {lovedByGuests ? "Stays our guests love" : "Featured city stays"}
          </h2>
          <p>
            {lovedByGuests
              ? "Highly rated stays chosen by HOST guests."
              : "A first look at distinctive stays in the city."}
          </p>
        </div>

        <a href="/search" className="btn-secondary">
          See all stays
        </a>
      </div>

      <div className="featured-stays-grid">
        {properties.map((property) => {
          const rating = Number(property.rating);
          const reviews = Number(property.review_count);
          const qualifies =
            Number.isFinite(rating) && rating >= 4.8 && reviews >= 10;

          return (
            <article className="featured-stay-card" key={property.id}>
              <a
                href={`/stays/${encodeURIComponent(property.slug || "")}`}
                className="featured-stay-image"
                aria-label={`View ${property.name}`}
              >
                {property.coverImage?.url ? (
                  <img
                    src={property.coverImage.url}
                    alt={
                      property.coverImage.altText ||
                      `${property.name} in ${property.city}`
                    }
                  />
                ) : (
                  <span className="featured-stay-placeholder" aria-hidden="true">
                    HOST
                  </span>
                )}

                <span className="featured-stay-badge">
                  {qualifies ? "Guest favourite" : "Featured stay"}
                </span>
              </a>

              <div className="featured-stay-body">
                <div className="featured-stay-title-row">
                  <a
                    href={`/stays/${encodeURIComponent(property.slug || "")}`}
                    className="featured-stay-name display"
                  >
                    {property.name}
                  </a>

                  {Number.isFinite(rating) && rating > 0 && (
                    <span className="featured-stay-rating">
                      {"\u2605"} {rating.toFixed(2)}
                      {reviews > 0 && <small> ({reviews})</small>}
                    </span>
                  )}
                </div>

                <p className="featured-stay-location">{property.city}</p>
                <p className="featured-stay-capacity">
                  Up to {property.max_guests}{" "}
                  {Number(property.max_guests) === 1 ? "guest" : "guests"}
                </p>
                <p className="featured-stay-price">
                  <strong>
                    {money(property.nightly_price, property.currency)}
                  </strong>{" "}
                  per night
                </p>
              </div>
            </article>
          );
        })}
      </div>

      <style>{`
        .featured-stays {
          max-width: 1240px;
          margin: 0 auto;
          padding: 34px 28px 82px;
        }

        .featured-stays-head {
          display: flex;
          align-items: end;
          justify-content: space-between;
          gap: 24px;
          margin-bottom: 28px;
        }

        .featured-stays-head h2 {
          margin: 10px 0 8px;
          font-size: clamp(28px, 4vw, 40px);
          font-weight: 400;
        }

        .featured-stays-head p {
          margin: 0;
          color: var(--warm-grey);
          line-height: 1.6;
        }

        .featured-stays-grid {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(250px, 292px));
          gap: 18px;
          justify-content: start;
        }

        .featured-stay-card {
          min-width: 0;
        }

        .featured-stay-image {
          position: relative;
          display: grid;
          height: 230px;
          overflow: hidden;
          place-items: center;
          border: 1px solid var(--stone);
          border-radius: 8px;
          background:
            linear-gradient(145deg, var(--stone), var(--graphite));
          color: var(--ivory);
          text-decoration: none;
        }

        .featured-stay-image img {
          width: 100%;
          height: 100%;
          object-fit: cover;
          transition: transform 280ms ease;
        }

        .featured-stay-card:hover .featured-stay-image img {
          transform: scale(1.025);
        }

        .featured-stay-placeholder {
          color: var(--brass);
          font-family: var(--font-display);
          font-size: 26px;
          letter-spacing: 0.08em;
        }

        .featured-stay-badge {
          position: absolute;
          top: 12px;
          left: 12px;
          padding: 7px 10px;
          border: 1px solid rgba(242, 236, 222, 0.2);
          border-radius: 999px;
          background: rgba(20, 18, 14, 0.88);
          color: var(--ivory);
          font-size: 10px;
          letter-spacing: 0.04em;
        }

        .featured-stay-body {
          padding-top: 14px;
        }

        .featured-stay-title-row {
          display: flex;
          align-items: baseline;
          justify-content: space-between;
          gap: 12px;
        }

        .featured-stay-name {
          overflow: hidden;
          color: var(--ivory);
          font-size: 19px;
          text-decoration: none;
          text-overflow: ellipsis;
          white-space: nowrap;
        }

        .featured-stay-name:hover {
          color: var(--brass);
        }

        .featured-stay-rating {
          flex-shrink: 0;
          color: var(--ivory);
          font-size: 12px;
          font-variant-numeric: tabular-nums;
        }

        .featured-stay-rating small {
          color: var(--warm-grey);
          font-size: inherit;
        }

        .featured-stay-location,
        .featured-stay-capacity,
        .featured-stay-price {
          margin: 5px 0 0;
          color: var(--warm-grey);
          font-size: 12px;
          line-height: 1.45;
        }

        .featured-stay-price {
          margin-top: 10px;
          color: var(--ivory);
        }

        .featured-stay-price strong {
          color: var(--brass);
          font-size: 15px;
          font-variant-numeric: tabular-nums;
        }

        @media (max-width: 980px) {
          .featured-stays-grid {
            grid-template-columns: repeat(2, minmax(0, 1fr));
          }
        }

        @media (max-width: 620px) {
          .featured-stays {
            padding: 24px 20px 62px;
          }

          .featured-stays-head {
            align-items: stretch;
            flex-direction: column;
          }

          .featured-stays-head .btn-secondary {
            align-self: flex-start;
          }

          .featured-stays-grid {
            display: flex;
            margin-right: -20px;
            padding-right: 20px;
            gap: 14px;
            overflow-x: auto;
            scroll-snap-type: x mandatory;
          }

          .featured-stay-card {
            flex: 0 0 82vw;
            scroll-snap-align: start;
          }

          .featured-stay-image {
            height: 240px;
          }
        }

        @media (prefers-reduced-motion: reduce) {
          .featured-stay-image img {
            transition: none;
          }
        }
      `}</style>
    </section>
  );
}
