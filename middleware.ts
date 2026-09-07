import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { Redis } from "@upstash/redis/cloudflare";
import { Ratelimit } from "@upstash/ratelimit";

type Bucket = { count: number; resetAt: number };
const localBuckets = new Map<string, Bucket>();
const redisUrl = process.env.UPSTASH_REDIS_REST_URL;
const redisToken = process.env.UPSTASH_REDIS_REST_TOKEN;
const redis = redisUrl && redisToken
  ? new Redis({ url: redisUrl, token: redisToken })
  : null;
const authLimiter = redis ? new Ratelimit({ redis, limiter: Ratelimit.slidingWindow(5, "15 m"), prefix: "host:auth" }) : null;
const financialLimiter = redis ? new Ratelimit({ redis, limiter: Ratelimit.slidingWindow(20, "15 m"), prefix: "host:financial" }) : null;

function localLimit(key: string, limit: number, windowMs: number) {
  const now = Date.now(); const existing = localBuckets.get(key);
  if (!existing || now > existing.resetAt) { localBuckets.set(key, { count: 1, resetAt: now + windowMs }); return true; }
  if (existing.count >= limit) return false; existing.count++; return true;
}
function clientIp(request: NextRequest) { return request.headers.get("x-forwarded-for")?.split(",")[0].trim() ?? request.headers.get("x-real-ip") ?? "unknown"; }

const AUTH_PATHS = ["/api/auth/register", "/api/auth/password-reset/request", "/api/auth/password-reset/confirm", "/api/auth/email-verification/confirm", "/api/auth/recovery-code", "/api/auth/callback/credentials", "/api/account/recovery-codes", "/api/account/password", "/api/account/privacy"];
const FINANCIAL_PATHS = ["/api/payments/", "/api/bookings", "/api/admin/refunds", "/api/admin/security/actions"];
const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);
function isExemptMutation(pathname: string) {
  return pathname.startsWith("/api/webhooks/") || pathname === "/api/cron/sweep" ||
    (pathname.startsWith("/api/auth/") && !AUTH_PATHS.some((path) => pathname.startsWith(path)));
}
function trustedOrigin(request: NextRequest) {
  const origin = request.headers.get("origin"); if (!origin) return false;
  const allowed = new Set([request.nextUrl.origin]);
  if (process.env.APP_URL) { try { allowed.add(new URL(process.env.APP_URL).origin); } catch { /* validated at deployment */ } }
  return allowed.has(origin);
}
function addSecurityHeaders(response: NextResponse) {
  const devEval = process.env.NODE_ENV === "development" ? " 'unsafe-eval'" : "";
  response.headers.set("Content-Security-Policy", [
    "default-src 'self'", `script-src 'self' 'unsafe-inline'${devEval} https://js.stripe.com`,
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com", "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' data: blob:", "connect-src 'self' https://api.stripe.com https://*.stripe.com",
    "frame-src https://js.stripe.com https://hooks.stripe.com", "object-src 'none'", "base-uri 'self'",
    "form-action 'self'", "frame-ancestors 'none'",
  ].join("; "));
  response.headers.set("X-Content-Type-Options", "nosniff"); response.headers.set("X-Frame-Options", "DENY");
  response.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  response.headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=(self)");
  response.headers.set("Cross-Origin-Opener-Policy", "same-origin-allow-popups");
  if (process.env.NODE_ENV === "production") response.headers.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  return response;
}

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl; const ip = clientIp(request);
  if (MUTATING.has(request.method) && pathname.startsWith("/api/") && !isExemptMutation(pathname) && !trustedOrigin(request)) {
    return addSecurityHeaders(NextResponse.json({ success: false, error: { code: "INVALID_ORIGIN", message: "Request origin was not accepted." } }, { status: 403 }));
  }
  const authPath = MUTATING.has(request.method) && AUTH_PATHS.some((path) => pathname.startsWith(path));
  const financialPath = FINANCIAL_PATHS.some((path) => pathname.startsWith(path)) && MUTATING.has(request.method);
  if (authPath || financialPath) {
    const distributed = authPath ? authLimiter : financialLimiter; let allowed: boolean;
    if (distributed) allowed = (await distributed.limit(ip)).success;
    else if (process.env.NODE_ENV === "production" || process.env.SECURITY_REQUIRE_DISTRIBUTED_RATE_LIMIT === "true") {
      return addSecurityHeaders(NextResponse.json({ success: false, error: { code: "SECURITY_NOT_CONFIGURED", message: "Security service is temporarily unavailable." } }, { status: 503 }));
    } else allowed = localLimit(`${authPath ? "auth" : "financial"}:${ip}`, authPath ? 5 : 20, 15 * 60_000);
    if (!allowed) return addSecurityHeaders(NextResponse.json({ success: false, error: { code: "RATE_LIMITED", message: "Too many attempts. Try again later." } }, { status: 429 }));
  }
  const response = NextResponse.next(); if (pathname.startsWith("/api/admin")) response.headers.set("X-Robots-Tag", "noindex, nofollow");
  return addSecurityHeaders(response);
}
export const config = { matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"] };
