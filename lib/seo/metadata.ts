/**
 * SEO is mostly a frontend/page-rendering concern (per-page <title>,
 * <meta>, canonical tags) — this backend has no page routes to attach
 * that to yet. What genuinely belongs here, and what's built: the
 * *data* a frontend needs to render those tags correctly, plus the two
 * artifacts (sitemap, robots.txt) that need live database access to
 * generate and so are naturally server-rendered rather than static files.
 */

export type PropertySeoInput = {
  slug: string;
  name: string;
  city: string;
  country: string;
  district: string | null;
  description: string | null;
  nightlyPrice: number;
  currency: string;
  rating: number | null;
  reviewCount: number;
  primaryImageUrl: string | null;
  latitude: number;
  longitude: number;
};

export function generatePropertyMetadata(p: PropertySeoInput, baseUrl: string) {
  const title = `${p.name} — ${p.district ? `${p.district}, ` : ""}${p.city} | HOST`;
  const description = p.description
    ? truncate(p.description, 155)
    : `Stay at ${p.name} in ${p.city}, ${p.country}. From ${p.currency}${p.nightlyPrice}/night on HOST.`;
  const canonical = `${baseUrl}/stays/${p.slug}`;

  // schema.org LodgingBusiness — the structured data type Google's docs
  // specifically recommend for accommodation listings, over the more
  // generic Product type.
  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "LodgingBusiness",
    name: p.name,
    description: p.description ?? description,
    url: canonical,
    image: p.primaryImageUrl ?? undefined,
    address: {
      "@type": "PostalAddress",
      addressLocality: p.district ?? p.city,
      addressRegion: p.city,
      addressCountry: p.country,
    },
    geo: { "@type": "GeoCoordinates", latitude: p.latitude, longitude: p.longitude },
    priceRange: `${p.currency}${p.nightlyPrice}`,
    ...(p.rating != null ? { aggregateRating: { "@type": "AggregateRating", ratingValue: p.rating, reviewCount: p.reviewCount } } : {}),
  };

  return {
    title,
    description,
    canonical,
    openGraph: { title, description, url: canonical, images: p.primaryImageUrl ? [p.primaryImageUrl] : [] },
    jsonLd,
  };
}

export function generateDestinationMetadata(city: string, country: string, propertyCount: number, baseUrl: string) {
  const title = `Stays in ${city} | HOST`;
  const description = `${propertyCount} places to stay in ${city}, ${country}, on HOST.`;
  const canonical = `${baseUrl}/destinations/${slugify(city)}`;
  return { title, description, canonical, openGraph: { title, description, url: canonical } };
}

function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength - 1).trimEnd() + "…";
}

export function slugify(text: string): string {
  return text.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
}
