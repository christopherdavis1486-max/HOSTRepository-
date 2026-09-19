"use client";

import { useEffect, useMemo, useState } from "react";
import {
  PropertyMap,
  type PropertyMapMarker,
} from "@/components/PropertyMap";

type PublicProperty = {
  id: string;
  name: string;
  slug: string | null;
  city: string;
  publicLocation: {
    type: "Point";
    coordinates: [number, number];
  } | null;
};

type HomepagePropertyMapProps = {
  eyebrow: string;
  heading: string;
  privacyMessage: string;
  loadingMessage: string;
};

export function HomepagePropertyMap({
  eyebrow,
  heading,
  privacyMessage,
  loadingMessage,
}: HomepagePropertyMapProps) {
  const [properties, setProperties] = useState<PublicProperty[]>([]);
  const [state, setState] = useState<
    "loading" | "loaded" | "error"
  >("loading");

  useEffect(() => {
    const controller = new AbortController();

    fetch("/api/properties", {
      cache: "no-store",
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) {
          throw new Error("Unable to load public properties.");
        }

        const data = await response.json();

        if (!data.success || !Array.isArray(data.properties)) {
          throw new Error("Invalid public property response.");
        }

        setProperties(data.properties);
        setState("loaded");
      })
      .catch((error: unknown) => {
        if (
          error instanceof DOMException &&
          error.name === "AbortError"
        ) {
          return;
        }

        setState("error");
      });

    return () => controller.abort();
  }, []);

  const markers = useMemo<PropertyMapMarker[]>(
    () =>
      properties.flatMap((property) => {
        const location = property.publicLocation;

        if (
          !location ||
          location.type !== "Point" ||
          !Array.isArray(location.coordinates) ||
          location.coordinates.length !== 2
        ) {
          return [];
        }

        const [longitude, latitude] = location.coordinates;

        return [{
          id: property.id,
          name: property.name,
          city: property.city,
          slug: property.slug,
          position: [latitude, longitude] as [number, number],
        }];
      }),
    [properties],
  );

  if (state === "error") {
    return null;
  }

  return (
    <section className="property-map-section">
      <div className="section-head">
        <div className="eyebrow">{eyebrow}</div>
        <h2 className="display">{heading}</h2>
      </div>

      {state === "loading" && (
        <div
          className="property-map-loading"
          role="status"
          aria-live="polite"
        >
          {loadingMessage}
        </div>
      )}

      {state === "loaded" && markers.length > 0 && (
        <>
          <PropertyMap
            markers={markers}
            ariaLabel={heading}
          />
          <p className="property-map-privacy">
            {privacyMessage}
          </p>
        </>
      )}

      <style>{`
        .property-map-section {
          max-width: 1080px;
          margin: 0 auto;
          padding: 24px 28px 72px;
        }

        .property-map-section .section-head {
          margin-bottom: 32px;
          text-align: center;
        }

        .property-map-section .eyebrow {
          color: var(--brass);
          font-size: 11px;
          letter-spacing: 0.14em;
          text-transform: uppercase;
        }

        .property-map-section .display {
          margin: 10px 0 0;
          font-family: var(--font-display);
          font-size: 28px;
          font-weight: 400;
        }

        .property-map-loading {
          display: grid;
          min-height: 260px;
          place-items: center;
          border: 1px solid var(--stone);
          border-radius: 8px;
          background: var(--graphite);
          color: var(--warm-grey);
          font-size: 13px;
        }

        .property-map-privacy {
          margin: 12px 0 0;
          color: var(--warm-grey);
          font-size: 12px;
          line-height: 1.6;
          text-align: center;
        }

        @media (max-width: 720px) {
          .property-map-section {
            padding: 18px 20px 56px;
          }
        }
      `}</style>
    </section>
  );
}
