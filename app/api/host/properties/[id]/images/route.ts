import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { AuthError, requireSession } from "@/lib/auth/session";
import { resolveHostPropertyAccess } from "@/lib/auth/hostAccess";
import {
  listPropertyImages,
  PropertyImageError,
  reorderPropertyImages,
  setPropertyImageCover,
  updatePropertyImageAltText,
} from "@/lib/hosts/propertyImages";

const imageActionSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("setCover"),
    imageId: z.string().uuid("Image ID must be valid."),
  }),
  z.object({
    action: z.literal("updateAltText"),
    imageId: z.string().uuid("Image ID must be valid."),
    altText: z
      .string()
      .trim()
      .max(300, "Alternative text must be 300 characters or fewer.")
      .nullable(),
  }),
  z.object({
    action: z.literal("reorder"),
    imageIds: z
      .array(z.string().uuid("Every image ID must be valid."))
      .max(30, "A property can have no more than 30 images."),
  }),
]);

function validationResponse(error: z.ZodError) {
  return NextResponse.json(
    {
      success: false,
      error: {
        code: "VALIDATION_ERROR",
        message: error.issues[0]?.message ?? "Invalid image request.",
        issues: error.issues,
      },
    },
    { status: 400 }
  );
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: propertyId } = await params;

  try {
    const session = await requireSession();
    await resolveHostPropertyAccess(session, propertyId);

    if (!session.user?.id) {
      throw new AuthError("Authentication required.", 401);
    }

    const images = await listPropertyImages(
      propertyId,
      session.user.id
    );

    return NextResponse.json({
      success: true,
      images,
    });
  } catch (error) {
    return handleImageRouteError(error, "load");
  }
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: propertyId } = await params;

  try {
    const session = await requireSession();
    await resolveHostPropertyAccess(session, propertyId);

    if (!session.user?.id) {
      throw new AuthError("Authentication required.", 401);
    }

    const body = await request.json();
    const parsed = imageActionSchema.safeParse(body);

    if (!parsed.success) {
      return validationResponse(parsed.error);
    }

    if (parsed.data.action === "setCover") {
      const image = await setPropertyImageCover(
        propertyId,
        parsed.data.imageId,
        session.user.id
      );

      return NextResponse.json({
        success: true,
        image,
      });
    }

    if (parsed.data.action === "updateAltText") {
      const normalizedAltText =
        parsed.data.altText === null ||
        parsed.data.altText.length === 0
          ? null
          : parsed.data.altText;

      const image = await updatePropertyImageAltText(
        propertyId,
        parsed.data.imageId,
        session.user.id,
        normalizedAltText
      );

      return NextResponse.json({
        success: true,
        image,
      });
    }

    const images = await reorderPropertyImages(
      propertyId,
      parsed.data.imageIds,
      session.user.id
    );

    return NextResponse.json({
      success: true,
      images,
    });
  } catch (error) {
    return handleImageRouteError(error, "update");
  }
}

function handleImageRouteError(
  error: unknown,
  operation: "load" | "update"
) {
  if (error instanceof AuthError) {
    return NextResponse.json(
      {
        success: false,
        error: {
          code: "UNAUTHORIZED",
          message: error.message,
        },
      },
      { status: error.status }
    );
  }

  if (error instanceof PropertyImageError) {
    return NextResponse.json(
      {
        success: false,
        error: {
          code: error.code,
          message: error.message,
        },
      },
      { status: error.status }
    );
  }

  console.error(`[HOST property-images/${operation}]`, error);

  return NextResponse.json(
    {
      success: false,
      error: {
        code:
          operation === "load"
            ? "PROPERTY_IMAGES_FAILED"
            : "PROPERTY_IMAGES_UPDATE_FAILED",
        message:
          operation === "load"
            ? "Unable to load property images."
            : "Unable to update property images.",
      },
    },
    { status: 500 }
  );
}