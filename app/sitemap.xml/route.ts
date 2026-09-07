import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { slugify } from "@/lib/seo/metadata";

/**
 * Dynamic — generated from real published-property data, not a static
 * file, since a property's presence here needs to track its actual
 * status. §51 of the platform brief's SEO section, §112 of the Atlas
 * spec's SEO section: this is the shared artifact both docs ask for.
 *
 * The intent above was always "dynamic," but nothing enforced that at
 * the framework level — this route has no cookies/dynamic-segment usage,
 * so Next.js's default heuristics treated it as statically prerenderable
 * and attempted to run this query at `next build` time, which fails
 * outright if the database isn't reachable during the build step (found
 * via an actual `next build` run). `force-dynamic` makes the intent
 * explicit and correct: this always runs per-request, never at build time.
 */
export const dynamic = "force-dynamic";

export async function GET() {
  const baseUrl = process.env.APP_URL ?? "https://example.com";

  const [properties, destinations] = await Promise.all([
db.query(`
  SELECT p.slug, p.updated_at
  FROM properties p
  WHERE p.status = 'published'
    AND p.compliance_status = 'approved'
    AND p.slug IS NOT NULL
    AND NOT EXISTS (
      SELECT 1
      FROM property_compliance_items pci
      WHERE pci.property_id = p.id
        AND pci.applicability = 'required'
        AND pci.valid_until IS NOT NULL
        AND pci.valid_until < CURRENT_DATE
    )
`),
   db.query(`
  SELECT DISTINCT p.city
  FROM properties p
  WHERE p.status = 'published'
    AND p.compliance_status = 'approved'
    AND NOT EXISTS (
      SELECT 1
      FROM property_compliance_items pci
      WHERE pci.property_id = p.id
        AND pci.applicability = 'required'
        AND pci.valid_until IS NOT NULL
        AND pci.valid_until < CURRENT_DATE
    )
`),
  ]);

  const staticUrls = [`${baseUrl}/`, `${baseUrl}/destinations`, `${baseUrl}/stays`];
  const destinationUrls = destinations.rows.map((r: any) => `${baseUrl}/destinations/${slugify(r.city)}`);
  const propertyUrls = properties.rows.map((r: any) => ({ loc: `${baseUrl}/stays/${r.slug}`, lastmod: new Date(r.updated_at).toISOString() }));

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${staticUrls.map(u => `  <url><loc>${u}</loc></url>`).join("\n")}
${destinationUrls.map(u => `  <url><loc>${u}</loc></url>`).join("\n")}
${propertyUrls.map(u => `  <url><loc>${u.loc}</loc><lastmod>${u.lastmod}</lastmod></url>`).join("\n")}
</urlset>`;

  return new NextResponse(xml, { headers: { "Content-Type": "application/xml", "Cache-Control": "public, s-maxage=3600" } });
}
