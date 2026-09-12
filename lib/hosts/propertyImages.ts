import type { PoolClient } from "pg";
import { db, withTransaction } from "@/lib/db";

export const MAX_PROPERTY_IMAGES = 30;

export type UploadedPropertyBlob = {
  url: string;
  pathname: string;
  contentType: string;
  size: number;
};

export type PropertyImage = {
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
  createdAt: string | Date;
  updatedAt: string | Date;
};

export class PropertyImageError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number
  ) {
    super(message);
    this.name = "PropertyImageError";
  }
}

type Queryable = Pick<PoolClient, "query">;

type PropertyImageRow = {
  id: string;
  property_id: string;
  blob_url: string;
  blob_pathname: string;
  content_type: string;
  size_bytes: string | number;
  width: number | null;
  height: number | null;
  alt_text: string | null;
  sort_order: number;
  is_cover: boolean;
  created_at: string | Date;
  updated_at: string | Date;
};

function mapPropertyImage(row: PropertyImageRow): PropertyImage {
  return {
    id: row.id,
    propertyId: row.property_id,
    url: row.blob_url,
    pathname: row.blob_pathname,
    contentType: row.content_type,
    sizeBytes: Number(row.size_bytes),
    width: row.width,
    height: row.height,
    altText: row.alt_text,
    sortOrder: row.sort_order,
    isCover: row.is_cover,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function assertPropertyOwnership(
  queryable: Queryable,
  propertyId: string,
  userId: string
): Promise<void> {
  const result = await queryable.query(
    `SELECT p.id
     FROM properties p
     JOIN host_profiles hp ON hp.id = p.host_id
     WHERE p.id = $1
       AND hp.user_id = $2 FOR UPDATE OF p`,
    [propertyId, userId]
  );

  if (result.rowCount === 0) {
    throw new PropertyImageError(
      "PROPERTY_NOT_FOUND",
      "Property not found or you do not have access to it.",
      404
    );
  }
}

async function getOwnedImage(
  queryable: Queryable,
  propertyId: string,
  imageId: string,
  userId: string
): Promise<PropertyImageRow> {
  await assertPropertyOwnership(queryable, propertyId, userId);

  const result = await queryable.query<PropertyImageRow>(
    `SELECT
       id,
       property_id,
       blob_url,
       blob_pathname,
       content_type,
       size_bytes,
       width,
       height,
       alt_text,
       sort_order,
       is_cover,
       created_at,
       updated_at
     FROM property_images
     WHERE id = $1
       AND property_id = $2`,
    [imageId, propertyId]
  );

  if (result.rowCount === 0) {
    throw new PropertyImageError(
      "PROPERTY_IMAGE_NOT_FOUND",
      "Property image not found.",
      404
    );
  }

  return result.rows[0];
}

export async function listPropertyImages(
  propertyId: string,
  userId: string
): Promise<PropertyImage[]> {
  await assertPropertyOwnership(db, propertyId, userId);

  const result = await db.query<PropertyImageRow>(
    `SELECT
       id,
       property_id,
       blob_url,
       blob_pathname,
       content_type,
       size_bytes,
       width,
       height,
       alt_text,
       sort_order,
       is_cover,
       created_at,
       updated_at
     FROM property_images
     WHERE property_id = $1
     ORDER BY sort_order, created_at, id`,
    [propertyId]
  );

  return result.rows.map(mapPropertyImage);
}

export async function registerUploadedPropertyImage(
  propertyId: string,
  userId: string,
  blob: UploadedPropertyBlob
): Promise<PropertyImage> {
  return withTransaction(async (client) => {
    await assertPropertyOwnership(client, propertyId, userId);

    const existing = await client.query<PropertyImageRow>(
      `SELECT
         id,
         property_id,
         blob_url,
         blob_pathname,
         content_type,
         size_bytes,
         width,
         height,
         alt_text,
         sort_order,
         is_cover,
         created_at,
         updated_at
       FROM property_images
       WHERE blob_url = $1`,
      [blob.url]
    );

    if (existing.rowCount && existing.rows[0].property_id !== propertyId) {
      throw new PropertyImageError(
        "PROPERTY_IMAGE_CONFLICT",
        "This uploaded image is already registered to another property.",
        409
      );
    }

    if (existing.rowCount) {
      return mapPropertyImage(existing.rows[0]);
    }

    const countResult = await client.query<{ image_count: string }>(
      `SELECT COUNT(*)::text AS image_count
       FROM property_images
       WHERE property_id = $1`,
      [propertyId]
    );

    const imageCount = Number(countResult.rows[0].image_count);

    if (imageCount >= MAX_PROPERTY_IMAGES) {
      throw new PropertyImageError(
        "PROPERTY_IMAGE_LIMIT_REACHED",
        `A property can have no more than ${MAX_PROPERTY_IMAGES} images.`,
        409
      );
    }

    const orderResult = await client.query<{ next_order: number }>(
      `SELECT COALESCE(MAX(sort_order), -1) + 1 AS next_order
       FROM property_images
       WHERE property_id = $1`,
      [propertyId]
    );

    const result = await client.query<PropertyImageRow>(
      `INSERT INTO property_images (
         property_id,
         blob_url,
         blob_pathname,
         content_type,
         size_bytes,
         sort_order,
         is_cover,
         created_by_user_id
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING
         id,
         property_id,
         blob_url,
         blob_pathname,
         content_type,
         size_bytes,
         width,
         height,
         alt_text,
         sort_order,
         is_cover,
         created_at,
         updated_at`,
      [
        propertyId,
        blob.url,
        blob.pathname,
        blob.contentType,
        blob.size,
        orderResult.rows[0].next_order,
        imageCount === 0,
        userId,
      ]
    );

    return mapPropertyImage(result.rows[0]);
  });
}

export async function setPropertyImageCover(
  propertyId: string,
  imageId: string,
  userId: string
): Promise<PropertyImage> {
  return withTransaction(async (client) => {
    await getOwnedImage(client, propertyId, imageId, userId);

    await client.query(
      `UPDATE property_images
       SET is_cover = FALSE,
           updated_at = NOW()
       WHERE property_id = $1
         AND is_cover = TRUE`,
      [propertyId]
    );

    const result = await client.query<PropertyImageRow>(
      `UPDATE property_images
       SET is_cover = TRUE,
           updated_at = NOW()
       WHERE id = $1
         AND property_id = $2
       RETURNING
         id,
         property_id,
         blob_url,
         blob_pathname,
         content_type,
         size_bytes,
         width,
         height,
         alt_text,
         sort_order,
         is_cover,
         created_at,
         updated_at`,
      [imageId, propertyId]
    );

    return mapPropertyImage(result.rows[0]);
  });
}

export async function updatePropertyImageAltText(
  propertyId: string,
  imageId: string,
  userId: string,
  altText: string | null
): Promise<PropertyImage> {
  return withTransaction(async (client) => {
    await getOwnedImage(client, propertyId, imageId, userId);

    const result = await client.query<PropertyImageRow>(
      `UPDATE property_images
       SET alt_text = $3,
           updated_at = NOW()
       WHERE id = $1
         AND property_id = $2
       RETURNING
         id,
         property_id,
         blob_url,
         blob_pathname,
         content_type,
         size_bytes,
         width,
         height,
         alt_text,
         sort_order,
         is_cover,
         created_at,
         updated_at`,
      [imageId, propertyId, altText]
    );

    return mapPropertyImage(result.rows[0]);
  });
}

export async function reorderPropertyImages(
  propertyId: string,
  imageIds: string[],
  userId: string
): Promise<PropertyImage[]> {
  return withTransaction(async (client) => {
    await assertPropertyOwnership(client, propertyId, userId);

    const result = await client.query<{ id: string }>(
      `SELECT id
       FROM property_images
       WHERE property_id = $1
       ORDER BY sort_order, created_at, id
       FOR UPDATE`,
      [propertyId]
    );

    const existingIds = result.rows.map((row) => row.id);

    if (
      imageIds.length !== existingIds.length ||
      new Set(imageIds).size !== imageIds.length ||
      existingIds.some((id) => !imageIds.includes(id))
    ) {
      throw new PropertyImageError(
        "INVALID_PROPERTY_IMAGE_ORDER",
        "The image order must contain every property image exactly once.",
        400
      );
    }

    for (const [sortOrder, imageId] of imageIds.entries()) {
      await client.query(
        `UPDATE property_images
         SET sort_order = $3,
             updated_at = NOW()
         WHERE id = $1
           AND property_id = $2`,
        [imageId, propertyId, sortOrder]
      );
    }

    const updated = await client.query<PropertyImageRow>(
      `SELECT
         id,
         property_id,
         blob_url,
         blob_pathname,
         content_type,
         size_bytes,
         width,
         height,
         alt_text,
         sort_order,
         is_cover,
         created_at,
         updated_at
       FROM property_images
       WHERE property_id = $1
       ORDER BY sort_order, created_at, id`,
      [propertyId]
    );

    return updated.rows.map(mapPropertyImage);
  });
}

export async function deletePropertyImage(
  propertyId: string,
  imageId: string,
  userId: string
): Promise<{ blobUrl: string }> {
  return withTransaction(async (client) => {
    const image = await getOwnedImage(
      client,
      propertyId,
      imageId,
      userId
    );

    await client.query(
      `DELETE FROM property_images
       WHERE id = $1
         AND property_id = $2`,
      [imageId, propertyId]
    );

    if (image.is_cover) {
      await client.query(
        `UPDATE property_images
         SET is_cover = TRUE,
             updated_at = NOW()
         WHERE id = (
           SELECT id
           FROM property_images
           WHERE property_id = $1
           ORDER BY sort_order, created_at, id
           LIMIT 1
         )`,
        [propertyId]
      );
    }

    return { blobUrl: image.blob_url };
  });
}