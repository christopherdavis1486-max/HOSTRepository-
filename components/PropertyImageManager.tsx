"use client";

import { upload } from "@vercel/blob/client";
import { useCallback, useEffect, useState } from "react";

type PropertyImage = {
  id: string;
  propertyId: string;
  url: string;
  pathname: string;
  contentType: string;
  sizeBytes: number;
  width: number | null;
  height: number | null;
  altText: string | null;
  sortOrder: number;
  isCover: boolean;
  createdAt: string;
  updatedAt: string;
};

type PropertyImageManagerProps = {
  propertyId: string;
};

const MAX_IMAGES = 30;
const MAX_SIZE_BYTES = 10 * 1024 * 1024;

const allowedTypes = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
]);

export function PropertyImageManager({
  propertyId,
}: PropertyImageManagerProps) {
  const [images, setImages] = useState<PropertyImage[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [busyImageId, setBusyImageId] = useState<string | null>(
    null
  );
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const endpoint = `/api/host/properties/${propertyId}/images`;

  const loadImages = useCallback(async () => {
    try {
      const response = await fetch(endpoint, {
        credentials: "include",
        cache: "no-store",
      });
      const data = await response.json();

      if (!response.ok || !data.success) {
        throw new Error(
          data.error?.message ?? "Unable to load property images."
        );
      }

      setImages(data.images);
    } catch (loadError) {
      setError(
        loadError instanceof Error
          ? loadError.message
          : "Unable to load property images."
      );
    } finally {
      setLoading(false);
    }
  }, [endpoint]);

  useEffect(() => {
    void loadImages();
  }, [loadImages]);

  const patchImages = async (body: unknown) => {
    const response = await fetch(endpoint, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
      },
      credentials: "include",
      body: JSON.stringify(body),
    });

    const data = await response.json();

    if (!response.ok || !data.success) {
      throw new Error(
        data.error?.message ?? "Unable to update property images."
      );
    }

    return data;
  };

  const handleUpload = async (
    event: React.ChangeEvent<HTMLInputElement>
  ) => {
    const files = Array.from(event.target.files ?? []);
    event.target.value = "";

    if (files.length === 0) {
      return;
    }

    setError(null);
    setMessage(null);

    if (images.length + files.length > MAX_IMAGES) {
      setError(
        `A property can have no more than ${MAX_IMAGES} images.`
      );
      return;
    }

    const invalidType = files.find(
      (file) => !allowedTypes.has(file.type)
    );

    if (invalidType) {
      setError(
        `${invalidType.name} is not a JPEG, PNG or WebP image.`
      );
      return;
    }

    const oversized = files.find(
      (file) => file.size > MAX_SIZE_BYTES
    );

    if (oversized) {
      setError(
        `${oversized.name} is larger than the 10 MB limit.`
      );
      return;
    }

    setUploading(true);

    try {
      for (const file of files) {
        await upload(file.name, file, {
          access: "public",
          handleUploadUrl:
            `/api/host/properties/${propertyId}/images/upload`,
        });
      }

      await loadImages();
      setMessage(
        files.length === 1
          ? "Image uploaded."
          : `${files.length} images uploaded.`
      );
    } catch (uploadError) {
      setError(
        uploadError instanceof Error
          ? uploadError.message
          : "Unable to upload the image."
      );
    } finally {
      setUploading(false);
    }
  };

  const setCover = async (imageId: string) => {
    setBusyImageId(imageId);
    setError(null);
    setMessage(null);

    try {
      await patchImages({
        action: "setCover",
        imageId,
      });
      await loadImages();
      setMessage("Cover image updated.");
    } catch (coverError) {
      setError(
        coverError instanceof Error
          ? coverError.message
          : "Unable to update the cover image."
      );
    } finally {
      setBusyImageId(null);
    }
  };

  const saveAltText = async (
    imageId: string,
    altText: string
  ) => {
    setBusyImageId(imageId);
    setError(null);
    setMessage(null);

    try {
      await patchImages({
        action: "updateAltText",
        imageId,
        altText,
      });
      await loadImages();
      setMessage("Image description saved.");
    } catch (altError) {
      setError(
        altError instanceof Error
          ? altError.message
          : "Unable to save the image description."
      );
    } finally {
      setBusyImageId(null);
    }
  };

  const moveImage = async (
    imageId: string,
    direction: -1 | 1
  ) => {
    const currentIndex = images.findIndex(
      (image) => image.id === imageId
    );
    const destinationIndex = currentIndex + direction;

    if (
      currentIndex < 0 ||
      destinationIndex < 0 ||
      destinationIndex >= images.length
    ) {
      return;
    }

    const reordered = [...images];
    const [movedImage] = reordered.splice(currentIndex, 1);
    reordered.splice(destinationIndex, 0, movedImage);

    setBusyImageId(imageId);
    setError(null);
    setMessage(null);
    setImages(reordered);

    try {
      const data = await patchImages({
        action: "reorder",
        imageIds: reordered.map((image) => image.id),
      });
      setImages(data.images);
      setMessage("Image order updated.");
    } catch (orderError) {
      await loadImages();
      setError(
        orderError instanceof Error
          ? orderError.message
          : "Unable to update the image order."
      );
    } finally {
      setBusyImageId(null);
    }
  };

  const removeImage = async (image: PropertyImage) => {
    if (
      !window.confirm(
        "Delete this image permanently from the property?"
      )
    ) {
      return;
    }

    setBusyImageId(image.id);
    setError(null);
    setMessage(null);

    try {
      const response = await fetch(
        `${endpoint}/${image.id}`,
        {
          method: "DELETE",
          credentials: "include",
        }
      );
      const data = await response.json();

      if (!response.ok || !data.success) {
        throw new Error(
          data.error?.message ?? "Unable to delete the image."
        );
      }

      await loadImages();

      setMessage(
        data.blobDeleted
          ? "Image deleted."
          : "Image removed from the property. Blob cleanup will need retrying."
      );
    } catch (deleteError) {
      setError(
        deleteError instanceof Error
          ? deleteError.message
          : "Unable to delete the image."
      );
    } finally {
      setBusyImageId(null);
    }
  };

  return (
    <section
      style={{
        marginTop: 28,
        paddingTop: 24,
        borderTop: "1px solid var(--border)",
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          gap: 16,
          alignItems: "flex-start",
          flexWrap: "wrap",
          marginBottom: 18,
        }}
      >
        <div>
          <h2 style={{ margin: "0 0 6px" }}>
            Property images
          </h2>
          <p
            style={{
              margin: 0,
              color: "var(--warm-grey)",
              lineHeight: 1.6,
            }}
          >
            Upload up to {MAX_IMAGES} JPEG, PNG or WebP images.
            Each image can be no larger than 10 MB.
          </p>
        </div>

        <label
          style={{
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            minHeight: 42,
            padding: "0 18px",
            borderRadius: 8,
            background: uploading
              ? "#c4a98b"
              : "#d49a3f",
            color: "#100f0c",
            border: "1px solid #e9bd70",
            boxShadow: "0 2px 8px rgba(0, 0, 0, 0.35)",
            fontWeight: 700,
            cursor: uploading ? "not-allowed" : "pointer",
          }}
        >
          {uploading ? "Uploading…" : "Upload images"}
          <input
            type="file"
            accept="image/jpeg,image/png,image/webp"
            multiple
            disabled={
              uploading || images.length >= MAX_IMAGES
            }
            onChange={handleUpload}
            style={{ display: "none" }}
          />
        </label>
      </div>

      {error && (
        <p
          role="alert"
          style={{
            color: "#b42318",
            margin: "0 0 16px",
          }}
        >
          {error}
        </p>
      )}

      {message && (
        <p
          role="status"
          style={{
            color: "#287d3c",
            margin: "0 0 16px",
          }}
        >
          {message}
        </p>
      )}

      {loading ? (
        <p style={{ color: "var(--warm-grey)" }}>
          Loading images…
        </p>
      ) : images.length === 0 ? (
        <div
          style={{
            padding: 24,
            border: "1px dashed var(--border)",
            borderRadius: 10,
            color: "var(--warm-grey)",
          }}
        >
          No property images have been uploaded yet.
        </div>
      ) : (
        <div
          style={{
            display: "grid",
            gridTemplateColumns:
              "repeat(auto-fill, minmax(240px, 320px))",
            justifyContent: "start",
            gap: 18,
          }}
        >
          {images.map((image, index) => (
            <ImageEditor
              key={image.id}
              image={image}
              index={index}
              imageCount={images.length}
              busy={busyImageId === image.id}
              onSetCover={setCover}
              onSaveAltText={saveAltText}
              onMove={moveImage}
              onDelete={removeImage}
            />
          ))}
        </div>
      )}
    </section>
  );
}

type ImageEditorProps = {
  image: PropertyImage;
  index: number;
  imageCount: number;
  busy: boolean;
  onSetCover: (imageId: string) => Promise<void>;
  onSaveAltText: (
    imageId: string,
    altText: string
  ) => Promise<void>;
  onMove: (
    imageId: string,
    direction: -1 | 1
  ) => Promise<void>;
  onDelete: (image: PropertyImage) => Promise<void>;
};

function ImageEditor({
  image,
  index,
  imageCount,
  busy,
  onSetCover,
  onSaveAltText,
  onMove,
  onDelete,
}: ImageEditorProps) {
  const [altText, setAltText] = useState(
    image.altText ?? ""
  );

  useEffect(() => {
    setAltText(image.altText ?? "");
  }, [image.altText]);

  return (
    <article
      style={{
        overflow: "hidden",
        border: image.isCover
          ? "2px solid var(--gold)"
          : "1px solid var(--border)",
        borderRadius: 10,
        background: "var(--surface)",
      }}
    >
      <div
        style={{
          position: "relative",
          aspectRatio: "4 / 3",
          background: "#e8e5df",
        }}
      >
        <img
          src={image.url}
          alt={image.altText ?? ""}
          style={{
            display: "block",
            width: "100%",
            height: "100%",
            objectFit: "cover",
          }}
        />

        {image.isCover && (
          <span
            style={{
              position: "absolute",
              top: 10,
              left: 10,
              padding: "5px 9px",
              borderRadius: 999,
              background: "var(--gold)",
              color: "#111",
              fontSize: 12,
              fontWeight: 800,
            }}
          >
            Cover
          </span>
        )}
      </div>

      <div style={{ padding: 14 }}>
        <label
          htmlFor={`alt-${image.id}`}
          style={{
            display: "block",
            fontSize: 13,
            fontWeight: 700,
            marginBottom: 6,
          }}
        >
          Image description
        </label>

        <input
          id={`alt-${image.id}`}
          value={altText}
          maxLength={300}
          disabled={busy}
          placeholder="Describe the image for accessibility"
          onChange={(event) =>
            setAltText(event.target.value)
          }
          style={{
            width: "100%",
            boxSizing: "border-box",
            minHeight: 40,
            padding: "8px 10px",
            border: "1px solid var(--border)",
            borderRadius: 7,
            marginBottom: 10,
          }}
        />

        <div
          style={{
            display: "flex",
            gap: 8,
            flexWrap: "wrap",
          }}
        >
          <button
            type="button"
            disabled={
              busy ||
              altText.trim() === (image.altText ?? "")
            }
            onClick={() =>
              void onSaveAltText(image.id, altText)
            }
          >
            Save description
          </button>

          {!image.isCover && (
            <button
              type="button"
              disabled={busy}
              onClick={() => void onSetCover(image.id)}
            >
              Make cover
            </button>
          )}

          <button
            type="button"
            disabled={busy || index === 0}
            aria-label="Move image earlier"
            onClick={() => void onMove(image.id, -1)}
          >
            Move earlier
          </button>

          <button
            type="button"
            disabled={busy || index === imageCount - 1}
            aria-label="Move image later"
            onClick={() => void onMove(image.id, 1)}
          >
            Move later
          </button>

          <button
            type="button"
            disabled={busy}
            onClick={() => void onDelete(image)}
            style={{ color: "#b42318" }}
          >
            Delete
          </button>
        </div>
      </div>
    </article>
  );
}