import { del } from "@vercel/blob";
import { NextRequest, NextResponse } from "next/server";
import { AuthError, requireSession } from "@/lib/auth/session";
import { resolveHostPropertyAccess } from "@/lib/auth/hostAccess";
import {
  deletePropertyImage,
  PropertyImageError,
} from "@/lib/hosts/propertyImages";

export async function DELETE(
  _request: NextRequest,
  {
    params,
  }: {
    params: Promise<{
      id: string;
      imageId: string;
    }>;
  }
) {
  const {
    id: propertyId,
    imageId,
  } = await params;

  try {
    const session = await requireSession();
    await resolveHostPropertyAccess(session, propertyId);

    if (!session.user?.id) {
      throw new AuthError("Authentication required.", 401);
    }

    const { blobUrl } = await deletePropertyImage(
      propertyId,
      imageId,
      session.user.id
    );

    let blobDeleted = true;

    try {
      await del(blobUrl);
    } catch (blobError) {
      blobDeleted = false;
      console.error(
        "[HOST property-image/blob-delete]",
        blobError
      );
    }

    return NextResponse.json({
      success: true,
      blobDeleted,
    });
  } catch (error) {
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

    console.error("[HOST property-image/delete]", error);

    return NextResponse.json(
      {
        success: false,
        error: {
          code: "PROPERTY_IMAGE_DELETE_FAILED",
          message: "Unable to delete the property image.",
        },
      },
      { status: 500 }
    );
  }
}