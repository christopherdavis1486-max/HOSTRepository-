"use client";

import { useMemo } from "react";
import {
  PropertyMap,
  type PropertyMapMarker,
} from "@/components/PropertyMap";

type PublicPoint = {
  type: "Point";
  coordinates: [number, number];
};

type PropertyLocationMapProps = {
  location: PublicPoint;
  heading: string;
  privacyMessage: string;
  placeLabel: string;
};

function validCoordinatePair(
  coordinates: [number, number],
): boolean {
  const [longitude, latitude] = coordinates;

  return (
    Number.isFinite(longitude) &&
    Number.isFinite(latitude) &&
    longitude >= -180 &&
    longitude <= 180 &&
    latitude >= -90 &&
    latitude <= 90
  );
}

export function PropertyLocationMap({
  location,
  heading,
  privacyMessage,
  placeLabel,
}: PropertyLocationMapProps) {
  const markers = useMemo<PropertyMapMarker[]>(() => {
    if (
      location.type !== "Point" ||
      !validCoordinatePair(location.coordinates)
    ) {
      return [];
    }

    const [longitude, latitude] = location.coordinates;

    return [{
      id: "property-location",
      name: heading,
      city: placeLabel,
      position: [latitude, longitude],
    }];
  }, [heading, location, placeLabel]);

  if (markers.length === 0) {
    return null;
  }

  return (
    <section
      className="property-location"
      aria-labelledby="property-location-heading"
    >
      <h2
        id="property-location-heading"
        className="display"
      >
        {heading}
      </h2>

      <p className="property-location-place">
        {placeLabel}
      </p>

      <PropertyMap
        markers={markers}
        ariaLabel={heading}
        compact
      />

      <p className="property-location-privacy">
        {privacyMessage}
      </p>

      <style>{`
        .property-location {
          margin-bottom: 32px;
        }

        .property-location h2 {
          margin-bottom: 8px;
          font-size: 18px;
          font-weight: 400;
        }

        .property-location-place,
        .property-location-privacy {
          color: var(--warm-grey);
          font-size: 13px;
          line-height: 1.6;
        }

        .property-location-place {
          margin: 0 0 12px;
        }

        .property-location-privacy {
          margin: 10px 0 0;
        }
      `}</style>
    </section>
  );
}
