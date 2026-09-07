/**
 * Extracted from app/stays/[slug]/page.tsx specifically to make the
 * PAGE's OWN interpretation of the property-detail API response
 * directly testable — not just the API route in isolation. This
 * environment has no real browser/DOM testing library available (a
 * genuine, standing constraint, not an oversight), and a client
 * component's useEffect never executes during a server-side
 * renderToString() call, so there is no way to exercise the page's
 * actual fetch-and-render behavior end-to-end without one. Extracting
 * the interpretation step into a pure function is what makes "does the
 * page ever let property data leak into rendered state for a 404
 * response" something Batch 5's draft-listing security fix can actually
 * prove, rather than only proving the API's own response shape is
 * correct in isolation.
 *
 * This function's only job: given the API's HTTP status and parsed
 * body, decide the page's load state — and, critically, whether
 * `property` data is returned at all. The real page component then just
 * calls this and sets state from the result; it doesn't duplicate this
 * logic inline.
 */

export type PropertyLoadResult =
  | { state: "notFound"; property: null }
  | { state: "error"; property: null }
  | { state: "loaded"; property: Record<string, unknown> };

export function interpretPropertyResponse(status: number, body: { success: boolean; property?: Record<string, unknown> }): PropertyLoadResult {
  if (status === 404) return { state: "notFound", property: null };
  if (!body.success || !body.property) return { state: "error", property: null };
  return { state: "loaded", property: body.property };
}
