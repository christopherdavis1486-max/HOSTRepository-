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
  if (
    location.type !== "Point" ||
    !validCoordinatePair(location.coordinates)
  ) {
    return null;
  }

  const [longitude, latitude] = location.coordinates;
  const longitudeMargin = 0.025;
  const latitudeMargin = 0.015;
  const bbox = [
    longitude - longitudeMargin,
    latitude - latitudeMargin,
    longitude + longitudeMargin,
    latitude + latitudeMargin,
  ].join(",");

  const mapUrl =
    "https://www.openstreetmap.org/export/embed.html" +
    `?bbox=${encodeURIComponent(bbox)}` +
    "&layer=mapnik" +
    `&marker=${encodeURIComponent(
      `${latitude},${longitude}`,
    )}`;

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

      <div className="property-map-frame">
        <iframe
          src={mapUrl}
          title={heading}
          loading="lazy"
          referrerPolicy="no-referrer"
          sandbox="allow-scripts allow-same-origin allow-popups"
        />
      </div>

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

        .property-map-frame {
          position: relative;
          height: 300px;
          overflow: hidden;
          border: 1px solid var(--stone);
          border-radius: 8px;
          background: var(--graphite);
        }

        .property-map-frame iframe {
          width: 100%;
          height: 100%;
          border: 0;
          filter: grayscale(0.85) sepia(0.25) brightness(0.72);
        }

        @media (max-width: 600px) {
          .property-map-frame {
            height: 240px;
          }
        }
      `}</style>
    </section>
  );
}
