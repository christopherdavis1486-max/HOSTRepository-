"use client";

import { useEffect, useRef } from "react";
import type { Map as LeafletMap } from "leaflet";

export type PropertyMapMarker = {
  id: string;
  name: string;
  city: string;
  slug?: string | null;
  priceLabel?: string | null;
  position: [number, number];
};

type PropertyMapProps = {
  markers: PropertyMapMarker[];
  ariaLabel: string;
  compact?: boolean;
};

function validPosition(
  position: [number, number],
): boolean {
  const [latitude, longitude] = position;

  return (
    Number.isFinite(latitude) &&
    Number.isFinite(longitude) &&
    latitude >= -90 &&
    latitude <= 90 &&
    longitude >= -180 &&
    longitude <= 180
  );
}

export function PropertyMap({
  markers,
  ariaLabel,
  compact = false,
}: PropertyMapProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<LeafletMap | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    const safeMarkers = markers.filter((marker) =>
      validPosition(marker.position),
    );

    if (!container || safeMarkers.length === 0) {
      return;
    }

    let cancelled = false;

    void import("leaflet").then((leafletModule) => {
      if (cancelled || mapRef.current) {
        return;
      }

      const L = leafletModule.default;
      const map = L.map(container, {
        scrollWheelZoom: false,
        zoomControl: true,
      });

      mapRef.current = map;

      L.tileLayer(
        "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
        {
          attribution:
            '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
          maxZoom: 18,
          detectRetina: true,
        },
      ).addTo(map);

      const tilePane = map.getPane("tilePane");

      if (tilePane) {
        tilePane.style.filter =
          "grayscale(1) contrast(1.08) brightness(1.02)";
      }

      const markerIcon = (marker: PropertyMapMarker) => {
        const label = marker.priceLabel?.trim();

        return L.divIcon({
          className: "host-map-marker",
          html: label
            ? `<span class="host-map-price">${label}</span>`
            : `<span class="host-map-pin" aria-hidden="true"><i></i></span>`,
          iconSize: label ? [82, 38] : [34, 42],
          iconAnchor: label ? [41, 34] : [17, 40],
          popupAnchor: [0, -34],
        });
      };

      const bounds = L.latLngBounds([]);

      for (const marker of safeMarkers) {
        const mapMarker = L.marker(marker.position, {
          icon: markerIcon(marker),
          title: marker.priceLabel
            ? `${marker.name}, ${marker.priceLabel} per night`
            : marker.name,
        }).addTo(map);

        bounds.extend(marker.position);

        const popup = document.createElement("div");
        popup.className = "host-map-popup";

        const name = document.createElement(
          marker.slug ? "a" : "strong",
        );
        name.textContent = marker.name;

        if (marker.slug && name instanceof HTMLAnchorElement) {
          name.href = `/stays/${encodeURIComponent(marker.slug)}`;
        }

        const city = document.createElement("span");
        city.textContent = marker.city;

        popup.append(name, city);

        if (marker.priceLabel) {
          const price = document.createElement("b");
          price.textContent = `${marker.priceLabel} per night`;
          popup.append(price);
        }
        mapMarker.bindPopup(popup);
      }

      if (safeMarkers.length === 1) {
        map.setView(safeMarkers[0].position, 13);
      } else {
        map.fitBounds(bounds, {
          padding: [36, 36],
          maxZoom: 12,
        });
      }

      window.setTimeout(() => map.invalidateSize(), 0);
    });

    return () => {
      cancelled = true;
      mapRef.current?.remove();
      mapRef.current = null;
    };
  }, [markers]);

  if (markers.length === 0) {
    return null;
  }

  return (
    <div
      className={compact ? "host-map compact" : "host-map"}
      role="region"
      aria-label={ariaLabel}
    >
      <div ref={containerRef} className="host-map-canvas" />

      <style>{`
        .host-map {
          position: relative;
          height: 430px;
          overflow: hidden;
          border: 1px solid var(--stone, #2a251c);
          border-radius: 8px;
          background: var(--graphite, #1f1b15);
        }

        .host-map.compact {
          height: 300px;
        }

        .host-map-canvas {
          width: 100%;
          height: 100%;
        }

        .host-map .leaflet-tile-pane {
          filter: grayscale(1) contrast(1.08) brightness(1.02);
        }

        .host-map .leaflet-control-zoom a {
          border-color: #2a251c;
          background: #14120e;
          color: #f2ecde;
        }

        .host-map .leaflet-control-attribution {
          background: rgba(20, 18, 14, 0.82);
          color: #a79e8c;
        }

        .host-map .leaflet-control-attribution a {
          color: #c9974b;
        }

        .host-map .host-map-marker {
          background: transparent;
          border: 0;
        }

        .host-map .host-map-pin {
          position: relative;
          display: block;
          width: 30px;
          height: 30px;
          transform: rotate(-45deg);
          border: 2px solid #f2ecde;
          border-radius: 50% 50% 50% 4px;
          background: #c9974b;
          box-shadow: 0 4px 14px rgba(0, 0, 0, 0.55);
        }

        .host-map .host-map-pin i {
          position: absolute;
          top: 8px;
          left: 8px;
          width: 10px;
          height: 10px;
          border-radius: 50%;
          background: #14120e;
        }

        .host-map .host-map-price {
          position: relative;
          display: inline-flex;
          min-width: 68px;
          min-height: 34px;
          align-items: center;
          justify-content: center;
          padding: 7px 11px;
          border: 2px solid #f2ecde;
          border-radius: 999px;
          background: #c9974b;
          box-shadow: 0 4px 14px rgba(0, 0, 0, 0.55);
          color: #14120e;
          font-family: "Space Grotesk", system-ui, sans-serif;
          font-size: 12px;
          font-weight: 600;
          font-variant-numeric: tabular-nums;
          white-space: nowrap;
        }

        .host-map .host-map-price::after {
          position: absolute;
          bottom: -7px;
          left: 50%;
          width: 10px;
          height: 10px;
          transform: translateX(-50%) rotate(45deg);
          border-right: 2px solid #f2ecde;
          border-bottom: 2px solid #f2ecde;
          background: #c9974b;
          content: "";
        }

        .host-map .leaflet-popup-content-wrapper,
        .host-map .leaflet-popup-tip {
          background: #14120e;
          color: #f2ecde;
        }

        .host-map .leaflet-popup-content-wrapper {
          border: 1px solid #c9974b;
          border-radius: 6px;
        }

        .host-map .host-map-popup {
          display: grid;
          gap: 3px;
          min-width: 130px;
          font-family: "Space Grotesk", system-ui, sans-serif;
        }

        .host-map .host-map-popup a,
        .host-map .host-map-popup strong {
          color: #f2ecde;
          font-family: "Fraunces", Georgia, serif;
          font-size: 14px;
          text-decoration: none;
        }

        .host-map .host-map-popup a:hover {
          color: #c9974b;
        }

        .host-map .host-map-popup span {
          color: #a79e8c;
          font-size: 11px;
        }

        .host-map .host-map-popup b {
          color: #c9974b;
          font-size: 12px;
          font-variant-numeric: tabular-nums;
        }

        @media (max-width: 600px) {
          .host-map {
            height: 330px;
          }

          .host-map.compact {
            height: 240px;
          }
        }
      `}</style>
    </div>
  );
}
