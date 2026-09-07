import { NextResponse } from "next/server";

export async function GET() {
  const baseUrl = process.env.APP_URL ?? "https://example.com";
  const body = `User-agent: *
Allow: /stays
Allow: /destinations
Disallow: /admin
Disallow: /api
Disallow: /host/dashboard
Disallow: /account

Sitemap: ${baseUrl}/sitemap.xml
`;
  // Admin explicitly disallowed here, but per the technical spec's §44,
  // this is a courtesy for well-behaved crawlers — the real protection is
  // the X-Robots-Tag header + actual auth on /admin routes, not this file.
  return new NextResponse(body, { headers: { "Content-Type": "text/plain" } });
}
