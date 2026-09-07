/**
 * Extracted from app/stays/[slug]/page.tsx for the same reason
 * interpretPropertyResponse.ts was: this environment has no real
 * browser/DOM testing library, so a client component's own fetch
 * handlers can never be exercised end-to-end via rendering. Every
 * decision the Save/Saved control makes — determining the initial
 * saved state from GET /api/favourites, interpreting a save/unsave
 * mutation's response, and the state transitions around a busy,
 * in-flight request — is a pure function here, independently testable.
 *
 * Deliberately owns NO hardcoded user-facing English strings. Pure
 * helpers here only ever determine STATE (status/busy/error-present)
 * and the accessible-pressed boolean — never display text. The page
 * component is what calls gt(...) for anything shown to a guest,
 * including the fallback error message passed into
 * interpretFavouriteMutation below.
 */

export type FavouriteStatus = "unknown" | "unsaved" | "saved";

export type FavouriteState = {
  status: FavouriteStatus; // "unknown" until the initial GET resolves
  busy: boolean;
  error: string | null;
};

export const initialFavouriteState: FavouriteState = { status: "unknown", busy: false, error: null };

export type FavouritesLoadResult =
  | { kind: "signedOut" }
  | { kind: "error" }
  | { kind: "determined"; saved: boolean };

/**
 * Interprets GET /api/favourites — determines whether `propertyId`
 * appears in the returned properties array. A 401 here means the
 * visitor is simply signed out, NOT a failure to redirect for — the
 * page resolves this to a normal, browsable "unsaved" state so an
 * anonymous visitor can keep browsing undisturbed. Matches the real,
 * unmodified response shape: { success: true, properties: [...] },
 * each with at least an `id`.
 */
export function interpretFavouritesLoad(status: number, body: unknown, propertyId: string): FavouritesLoadResult {
  if (status === 401) return { kind: "signedOut" };
  const parsed = body as { success?: boolean; properties?: Array<{ id?: string }> } | null;
  if (!parsed?.success || !Array.isArray(parsed.properties)) return { kind: "error" };
  const saved = parsed.properties.some((p) => p?.id === propertyId);
  return { kind: "determined", saved };
}

export type FavouriteMutationResult =
  | { kind: "unauthorized" }
  | { kind: "success" }
  | { kind: "error"; message: string };

/**
 * Interprets a POST /api/favourites (save) or DELETE
 * /api/favourites/[propertyId] (unsave) response — both share the same
 * { success: boolean, error?: { message } } shape on the real,
 * unmodified routes. `fallbackErrorMessage` is REQUIRED and must be
 * supplied by the caller via gt(...) — this function owns no English
 * text of its own; if the server didn't supply a message, the
 * caller's own translated fallback is used verbatim.
 */
export function interpretFavouriteMutation(status: number, body: unknown, fallbackErrorMessage: string): FavouriteMutationResult {
  if (status === 401) return { kind: "unauthorized" };
  const parsed = body as { success?: boolean; error?: { message?: string } } | null;
  if (parsed?.success) return { kind: "success" };
  return { kind: "error", message: parsed?.error?.message ?? fallbackErrorMessage };
}

/**
 * Begins a save/unsave attempt. The busy guard lives here, not just in
 * the click handler — calling this while already busy is a genuine
 * no-op, returning the exact same state (never re-entering, never
 * clearing an in-flight error early). This is what "disable the
 * control while its request is running" actually reduces to as pure
 * logic: a second call before the first completes changes nothing.
 */
export function beginFavouriteAction(state: FavouriteState): FavouriteState {
  if (state.busy) return state;
  return { ...state, busy: true, error: null };
}

/**
 * Resolves an in-flight save/unsave attempt. On success, the status
 * becomes exactly what was intended (true for a save, false for an
 * unsave) and any error clears. On anything else — including
 * unauthorized, which the caller separately redirects for — the
 * PREVIOUS status is preserved untouched; only `busy` and `error`
 * change. This is the "never optimistically leave the UI in an
 * incorrect state" and "keep the previous saved state on failure"
 * rules as pure logic.
 */
export function completeFavouriteAction(state: FavouriteState, result: FavouriteMutationResult, intendedSaved: boolean): FavouriteState {
  if (result.kind === "success") {
    return { status: intendedSaved ? "saved" : "unsaved", busy: false, error: null };
  }
  if (result.kind === "unauthorized") {
    return { ...state, busy: false };
  }
  return { ...state, busy: false, error: result.message };
}

/** Pure — builds the /login redirect target for an ACTIVE save/unsave
 *  attempt that itself returned 401 (never for the initial, passive
 *  load). Takes pathname/search as plain strings so the caller reads
 *  window.location itself, inside an event handler, never during
 *  render. */
export function buildLoginRedirectUrl(pathname: string, search: string): string {
  const returnTo = `${pathname}${search}`;
  return `/login?returnTo=${encodeURIComponent(returnTo)}`;
}
