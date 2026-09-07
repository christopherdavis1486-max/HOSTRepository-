/**
 * Same-origin relative path check for the auth-preserving returnTo flow
 * (see app/login/page.tsx). Extracted into its own file because Next.js's
 * App Router strictly validates page.tsx exports — only the default
 * component plus a small allow-listed set of special exports (metadata,
 * generateMetadata, dynamic, etc.) are permitted; an arbitrary named
 * export alongside the default component fails the production build
 * outright ("X is not a valid Page export field"), even though tsc
 * doesn't know about that convention and reports no error at all. Found
 * by actually running `next build`, not by type-checking — exactly why
 * this project always verifies both.
 *
 * A same-origin relative path must start with exactly one "/" — "//" is
 * protocol-relative and would silently redirect off-site
 * (https://example.com//evil.com behaves like //evil.com to a browser).
 */
export function isSafeReturnPath(raw: string | null): string {
  if (raw && raw.startsWith("/") && !raw.startsWith("//")) return raw;
  return "/";
}
