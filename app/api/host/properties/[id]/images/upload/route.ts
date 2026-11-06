import { head } from "@vercel/blob";
import {
  handleUpload,
  type HandleUploadBody,
} from "@vercel/blob/client";
import { NextRequest, NextResponse } from "next/server";
import { AuthError, requireSession } from "@/lib/auth/session";
import { resolveHostPropertyAccess } from "@/lib/auth/hostAccess";
import {
  PropertyImageError,
  registerUploadedPropertyImage,
} from "@/lib/hosts/propertyImages";

type UploadTokenPayload = {
  propertyId: string;
  userId: string;
};

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: propertyId } = await params;

  try {
    const body = (await request.json()) as HandleUploadBody;

    const response = await handleUpload({
      request,
      body,
      onBeforeGenerateToken: async (pathname) => {
        const session = await requireSession();
        await resolveHostPropertyAccess(session, propertyId);

        if (!session.user?.id) {
          throw new AuthError("Authentication required.", 401);
        }

        const expectedPrefix = `properties/${propertyId}/`;
        if (
          typeof pathname !== "string" ||
          !pathname.startsWith(expectedPrefix) ||
          pathname.length === expectedPrefix.length
        ) {
          throw new PropertyImageError(
            "INVALID_UPLOAD_PATH",
            "The uploaded image does not belong to this property.",
            400
          );
        }

        const tokenPayload: UploadTokenPayload = {
          propertyId,
          userId: session.user.id,
        };

        return {
          allowedContentTypes: [
            "image/jpeg",
            "image/png",
            "image/webp",
          ],
          maximumSizeInBytes: 10 * 1024 * 1024,
          addRandomSuffix: true,
          tokenPayload: JSON.stringify(tokenPayload),
        };
      },
      onUploadCompleted: async ({ blob, tokenPayload }) => {
        if (!tokenPayload) {
          throw new PropertyImageError(
            "INVALID_UPLOAD_TOKEN",
            "The image upload token is missing.",
            400
          );
        }

        let payload: UploadTokenPayload;

        try {
          payload = JSON.parse(tokenPayload) as UploadTokenPayload;
        } catch {
          throw new PropertyImageError(
            "INVALID_UPLOAD_TOKEN",
            "The image upload token is invalid.",
            400
          );
        }

        if (
          payload.propertyId !== propertyId ||
          !payload.userId
        ) {
          throw new PropertyImageError(
            "INVALID_UPLOAD_TOKEN",
            "The image upload token does not match this property.",
            400
          );
        }

        if (!/^https:\/\/[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.public\.blob\.vercel-storage\.com\/[^\s?#\\]+$/i.test(blob.url)) {
          throw new PropertyImageError(
            "INVALID_UPLOAD_URL",
            "Image URL must be a public HTTPS Vercel Blob URL.",
            400
          );
        }
        const details = await head(blob.url);
        if (!/^https:\/\/[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.public\.blob\.vercel-storage\.com\/[^\s?#\\]+$/i.test(details.url)) {
          throw new PropertyImageError(
            "INVALID_UPLOAD_URL",
            "Image URL must be a public HTTPS Vercel Blob URL.",
            400
          );
        }
        const expectedPrefix = `properties/${propertyId}/`;
        if (
          !details.pathname.startsWith(expectedPrefix) ||
          details.pathname.length === expectedPrefix.length
        ) {
          throw new PropertyImageError(
            "INVALID_UPLOAD_PATH",
            "The uploaded image does not belong to this property.",
            400
          );
        }

        await registerUploadedPropertyImage(
          payload.propertyId,
          payload.userId,
          {
            url: details.url,
            pathname: details.pathname,
            contentType: details.contentType,
            size: details.size,
          }
        );
      },
    });

    return NextResponse.json(response);
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

    console.error("[HOST property-image/upload]", error);

    return NextResponse.json(
      {
        success: false,
        error: {
          code: "PROPERTY_IMAGE_UPLOAD_FAILED",
          message: "Unable to upload the property image.",
        },
      },
      { status: 500 }
    );
  }
}