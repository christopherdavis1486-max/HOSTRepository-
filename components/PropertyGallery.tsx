"use client";

import { useEffect, useState } from "react";

export type PublicPropertyImage = {
  id: string;
  url: string;
  altText: string | null;
  width: number | null;
  height: number | null;
  sortOrder: number;
  isCover: boolean;
};

type PropertyGalleryProps = {
  images: PublicPropertyImage[];
  propertyName: string;
};

export function PropertyGallery({
  images,
  propertyName,
}: PropertyGalleryProps) {
  const orderedImages = [...images].sort(
    (left, right) =>
      Number(right.isCover) - Number(left.isCover) ||
      left.sortOrder - right.sortOrder
  );

  const [selectedId, setSelectedId] = useState<
    string | null
  >(orderedImages[0]?.id ?? null);

  useEffect(() => {
    if (
      orderedImages.length > 0 &&
      !orderedImages.some(
        (image) => image.id === selectedId
      )
    ) {
      setSelectedId(orderedImages[0].id);
    }

    if (orderedImages.length === 0) {
      setSelectedId(null);
    }
  }, [orderedImages, selectedId]);

  if (orderedImages.length === 0) {
    return (
      <div
        aria-label={`${propertyName} image placeholder`}
        style={{
          height: 280,
          position: "relative",
          background:
            "linear-gradient(135deg, #2A251C 0%, #14120E 100%)",
        }}
      >
        <div
          style={{
            position: "absolute",
            inset: 0,
            background:
              "linear-gradient(180deg, transparent 40%, rgba(201,151,75,0.12) 100%)",
          }}
        />
      </div>
    );
  }

  const selectedImage =
    orderedImages.find(
      (image) => image.id === selectedId
    ) ?? orderedImages[0];

  return (
    <section
      aria-label={`${propertyName} image gallery`}
      style={{
        maxWidth: 1280,
        margin: "0 auto",
        padding: "0 28px",
      }}
    >
      <div
        style={{
          display: "grid",
          gridTemplateColumns:
            orderedImages.length > 1
              ? "minmax(0, 4fr) minmax(180px, 1fr)"
              : "1fr",
          gap: 8,
          height: 440,
          overflow: "hidden",
          borderRadius: 8,
          background: "#2A251C",
        }}
      >
        <div
          style={{
            position: "relative",
            minWidth: 0,
            overflow: "hidden",
            background: "#2A251C",
          }}
        >
          <img
            src={selectedImage.url}
            alt={
              selectedImage.altText?.trim() ||
              `${propertyName} property image`
            }
            width={selectedImage.width ?? undefined}
            height={selectedImage.height ?? undefined}
            style={{
              display: "block",
              width: "100%",
              height: "100%",
              objectFit: "cover",
            }}
          />

          {orderedImages.length > 1 && (
            <div
              style={{
                position: "absolute",
                right: 14,
                bottom: 14,
                padding: "6px 10px",
                borderRadius: 999,
                background: "rgba(20,18,14,0.82)",
                color: "#F2ECDE",
                fontSize: 12,
              }}
            >
              {orderedImages.findIndex(
                (image) =>
                  image.id === selectedImage.id
              ) + 1}
              {" / "}
              {orderedImages.length}
            </div>
          )}
        </div>

        {orderedImages.length > 1 && (
          <div
            style={{
              display: "grid",
              gridAutoRows: "minmax(96px, 1fr)",
              gap: 8,
              overflowY: "auto",
              background: "#14120E",
            }}
          >
            {orderedImages.map((image, index) => {
              const selected =
                image.id === selectedImage.id;

              return (
                <button
                  key={image.id}
                  type="button"
                  aria-label={`View property image ${
                    index + 1
                  }`}
                  aria-pressed={selected}
                  onClick={() =>
                    setSelectedId(image.id)
                  }
                  style={{
                    minHeight: 96,
                    padding: 0,
                    border: selected
                      ? "2px solid #C9974B"
                      : "2px solid transparent",
                    borderRadius: 4,
                    overflow: "hidden",
                    background: "#2A251C",
                    cursor: "pointer",
                    opacity: selected ? 1 : 0.78,
                  }}
                >
                  <img
                    src={image.url}
                    alt=""
                    aria-hidden="true"
                    style={{
                      display: "block",
                      width: "100%",
                      height: "100%",
                      minHeight: 96,
                      objectFit: "cover",
                    }}
                  />
                </button>
              );
            })}
          </div>
        )}
      </div>

      <style>{`
        @media (max-width: 700px) {
          section[aria-label$="image gallery"] > div {
            grid-template-columns: 1fr !important;
            height: auto !important;
          }

          section[aria-label$="image gallery"] > div > div:first-child {
            height: 300px;
          }

          section[aria-label$="image gallery"] > div > div:last-child {
            grid-template-columns: repeat(4, minmax(90px, 1fr));
            grid-auto-rows: 82px !important;
            overflow-x: auto;
            overflow-y: hidden !important;
          }

          section[aria-label$="image gallery"] > div > div:last-child button,
          section[aria-label$="image gallery"] > div > div:last-child img {
            min-height: 82px !important;
          }
        }
      `}</style>
    </section>
  );
}