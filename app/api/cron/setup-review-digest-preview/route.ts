import { timingSafeEqual } from "node:crypto";
import { Pool } from "pg";
import { invokeScheduledSetupReviewDigest } from "@/lib/payments/invokeScheduledSetupReviewDigest";

export const runtime = "nodejs";

const hostedDatabaseHost = "ep-square-frog-za62ddfw.c-2.eu-west-2.aws.neon.tech";

export async function POST(request: Request) {
  const hostedPreview =
    process.env.VERCEL_ENV === "preview" &&
    process.env.VERCEL_GIT_COMMIT_REF === "host-staging-preview";
  if ((process.env.VERCEL || process.env.VERCEL_ENV) && !hostedPreview) {
    return Response.json({ error: "Preview unavailable." }, { status: 404 });
  }

  const secret = process.env.SETUP_REVIEW_DIGEST_PREVIEW_SECRET;
  const databaseUrl = process.env.SETUP_REVIEW_DIGEST_PREVIEW_DATABASE_URL;
  if (!secret || secret.length < 32 || !databaseUrl) {
    return Response.json({ error: "Preview unavailable." }, { status: 404 });
  }

  const supplied = Buffer.from(request.headers.get("authorization") ?? "");
  const expected = Buffer.from(`Bearer ${secret}`);
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
    return Response.json({ error: "Unauthorized." }, { status: 401 });
  }

  let url: URL;
  try {
    url = new URL(databaseUrl);
  } catch {
    return Response.json({ error: "Preview database unavailable." }, { status: 503 });
  }
  const database = hostedPreview ? "neondb" : "host_digest_staging";
  const allowedHost = hostedPreview
    ? url.hostname === hostedDatabaseHost && (!url.port || url.port === "5432")
    : ["127.0.0.1", "[::1]"].includes(url.hostname) && !url.search;

  if (
    !["postgres:", "postgresql:"].includes(url.protocol) ||
    !allowedHost || url.pathname !== `/${database}` ||
    url.hash || !url.username || (hostedPreview && !url.password)
  ) {
    return Response.json({ error: "Preview database unavailable." }, { status: 503 });
  }

  const body: unknown = await request.json().catch(() => null);
  const windowStartUtc =
    body && typeof body === "object" && "windowStartUtc" in body
      ? body.windowStartUtc
      : undefined;

  if (typeof windowStartUtc !== "string") {
    return Response.json({ error: "windowStartUtc is required." }, { status: 400 });
  }

  const pool = new Pool({
    host: url.hostname.replace(/^\[|\]$/g, ""),
    port: Number(url.port || 5432),
    database,
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    ssl: hostedPreview ? { rejectUnauthorized: true } : false,
    connectionTimeoutMillis: 5000,
  });

  try {
    const result = await invokeScheduledSetupReviewDigest(
      pool,
      {
        scope: hostedPreview ? "hosted-staging-preview" : "local-staging-preview",
        windowStartUtc,
        recoveryCutoffUtc: new Date(Date.now() - 10 * 60_000).toISOString(),
      },
      async ({ attemptToken }) => ({
        state: "sent",
        receipt: `mock-preview:${attemptToken}`,
      }),
    );
    return Response.json({ outcome: result.outcome });
  } catch (error) {
    if (
      error instanceof Error &&
      (error.message.startsWith("Invalid windowStartUtc.") ||
        error.message === "Scheduler window and recovery cutoff must not be in the future.")
    ) {
      return Response.json({ error: "Invalid windowStartUtc." }, { status: 400 });
    }
    return Response.json({ error: "Preview dispatch failed." }, { status: 500 });
  } finally {
    await pool.end();
  }
}
