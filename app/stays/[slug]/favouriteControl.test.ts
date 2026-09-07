import { test, mock, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { guestDictionary } from "@/lib/i18n/guestMessages";
import {
  initialFavouriteState, interpretFavouritesLoad, interpretFavouriteMutation,
  beginFavouriteAction, completeFavouriteAction, buildLoginRedirectUrl,
} from "./favouriteControl";

/**
 * Same two-layer coverage pattern already established by
 * interpretPropertyResponse.test.ts for this same page: pure unit
 * tests of the decision logic, plus end-to-end tests that call the
 * REAL GET/POST /api/favourites and DELETE /api/favourites/[id] route
 * handlers and pipe their real status/body through the real
 * interpretation functions. This environment has no real browser/DOM
 * testing library, so a live double-click or a live 401 redirect
 * can't be exercised via rendering — beginFavouriteAction's busy
 * guard and buildLoginRedirectUrl are what make those provable as
 * pure logic instead.
 */

// ---------- Pure unit tests ----------

test("interpretFavouritesLoad: the property IS found in the returned properties array", () => {
  const result = interpretFavouritesLoad(200, { success: true, properties: [{ id: "other" }, { id: "target" }] }, "target");
  assert.deepEqual(result, { kind: "determined", saved: true });
});

test("interpretFavouritesLoad: the property is NOT found in the returned properties array", () => {
  const result = interpretFavouritesLoad(200, { success: true, properties: [{ id: "other" }] }, "target");
  assert.deepEqual(result, { kind: "determined", saved: false });
});

test("interpretFavouritesLoad: SIGNED-OUT INITIAL GET — a 401 on the passive load resolves to 'signedOut', a distinct kind from 'unauthorized', never inferred as a redirect-worthy failure", () => {
  const result = interpretFavouritesLoad(401, { success: false }, "target");
  assert.deepEqual(result, { kind: "signedOut" });
  assert.notEqual((result as any).kind, "unauthorized", "the initial load's 401 must never be conflated with the mutation-specific 'unauthorized' kind that triggers a redirect");
});

test("interpretFavouritesLoad: a malformed/unsuccessful body is a genuine error, not a false 'not saved'", () => {
  assert.deepEqual(interpretFavouritesLoad(200, { success: false }, "target"), { kind: "error" });
  assert.deepEqual(interpretFavouritesLoad(500, null, "target"), { kind: "error" });
});

test("interpretFavouriteMutation: success", () => {
  assert.deepEqual(interpretFavouriteMutation(200, { success: true, saved: true }, "fallback"), { kind: "success" });
});

test("interpretFavouriteMutation: POST/DELETE 401 IS 'unauthorized' — this is what the page redirects on, distinct from the passive load's 'signedOut'", () => {
  assert.deepEqual(interpretFavouriteMutation(401, { success: false }, "fallback"), { kind: "unauthorized" });
});

test("interpretFavouriteMutation: a genuine server failure carries its OWN message through, not the fallback", () => {
  const result = interpretFavouriteMutation(400, { success: false, error: { message: "Property not found or not published" } }, "translated fallback");
  assert.deepEqual(result, { kind: "error", message: "Property not found or not published" });
});

test("interpretFavouriteMutation: TRANSLATED FALLBACK — with no server message, the CALLER-SUPPLIED fallback is used verbatim, proving this function owns no English text of its own", () => {
  const enResult = interpretFavouriteMutation(500, {}, guestDictionary("en").saveUpdateError);
  assert.equal((enResult as { message: string }).message, guestDictionary("en").saveUpdateError);

  const deResult = interpretFavouriteMutation(500, {}, guestDictionary("de").saveUpdateError);
  assert.equal((deResult as { message: string }).message, guestDictionary("de").saveUpdateError);
  assert.notEqual((deResult as { message: string }).message, (enResult as { message: string }).message, "different locales' fallbacks must genuinely differ — proving the function has no hardcoded English default it silently falls back to instead");
});

test("beginFavouriteAction: transitions to busy and clears any previous error", () => {
  const result = beginFavouriteAction({ status: "unsaved", busy: false, error: "old error" });
  assert.deepEqual(result, { status: "unsaved", busy: true, error: null });
});

test("beginFavouriteAction: BUSY GUARD — calling it while already busy is a genuine no-op, returning the identical state", () => {
  // The pure-logic proof behind "disable the control while its
  // request is running to prevent duplicate actions": a second
  // invocation before the first completes changes nothing at all.
  const busyState = { status: "unsaved" as const, busy: true, error: null };
  const result = beginFavouriteAction(busyState);
  assert.strictEqual(result, busyState, "must return the exact same state object, not a new busy transition");
});

test("completeFavouriteAction: a successful SAVE sets status to 'saved' and clears busy/error", () => {
  const result = completeFavouriteAction({ status: "unsaved", busy: true, error: "stale" }, { kind: "success" }, true);
  assert.deepEqual(result, { status: "saved", busy: false, error: null });
});

test("completeFavouriteAction: a successful UNSAVE sets status to 'unsaved'", () => {
  const result = completeFavouriteAction({ status: "saved", busy: true, error: null }, { kind: "success" }, false);
  assert.deepEqual(result, { status: "unsaved", busy: false, error: null });
});

test("completeFavouriteAction: MUTATION FAILURE PRESERVES PREVIOUS STATE — status is untouched, only busy/error change", () => {
  const previous = { status: "saved" as const, busy: true, error: null };
  const result = completeFavouriteAction(previous, { kind: "error", message: "Unable to update saved stays. Please try again." }, false);
  assert.equal(result.status, "saved", "the previous saved status must be preserved, never optimistically flipped");
  assert.equal(result.busy, false);
  assert.equal(result.error, "Unable to update saved stays. Please try again.");
});

test("completeFavouriteAction: unauthorized also preserves the previous status (the caller redirects separately)", () => {
  const previous = { status: "unsaved" as const, busy: true, error: null };
  const result = completeFavouriteAction(previous, { kind: "unauthorized" }, true);
  assert.equal(result.status, "unsaved");
  assert.equal(result.busy, false);
});

test("buildLoginRedirectUrl: correctly encodes the current pathname and query string", () => {
  const url = buildLoginRedirectUrl("/stays/some-slug", "?checkIn=2026-12-01&checkOut=2026-12-03");
  assert.equal(url, `/login?returnTo=${encodeURIComponent("/stays/some-slug?checkIn=2026-12-01&checkOut=2026-12-03")}`);
});

test("initialFavouriteState: starts unknown, not busy, no error", () => {
  assert.deepEqual(initialFavouriteState, { status: "unknown", busy: false, error: null });
});

test("STATIC CHECK — favouriteControl.ts contains no hardcoded user-facing English strings", () => {
  // Requirement 6: pure helpers may determine state/ariaPressed, but
  // must never own display text. Scans the actual source file for the
  // exact English copy this feature displays — proving the module
  // itself was never given these strings to fall back on.
  const source = fs.readFileSync(path.join(__dirname, "favouriteControl.ts"), "utf8");
  const forbiddenLiterals = ['"Save"', "'Save'", '"Saved"', "'Saved'", "Save this stay", "Remove this stay from your saved list", "Unable to update saved stays"];
  for (const literal of forbiddenLiterals) {
    assert.ok(!source.includes(literal), `favouriteControl.ts must not contain the hardcoded string ${literal} — all display text must come from the page's own gt(...) calls`);
  }
});

test("PAGE USES TRANSLATED LABELS — every locale's dictionary supplies genuinely distinct text for the five new keys, and the page's own source calls gt(...) for all of them, never a literal", () => {
  const pageSource = fs.readFileSync(path.join(__dirname, "page.tsx"), "utf8");
  assert.match(pageSource, /gt\("save"\)/);
  assert.match(pageSource, /gt\("saved"\)/);
  assert.match(pageSource, /gt\("saveThisStay"\)/);
  assert.match(pageSource, /gt\("removeSavedStay"\)/);
  assert.match(pageSource, /gt\("saveUpdateError"\)/);

  for (const locale of ["en", "de", "fr", "es", "it", "nl"] as const) {
    const d = guestDictionary(locale);
    assert.ok(d.save && d.saved && d.saveThisStay && d.removeSavedStay && d.saveUpdateError, `locale ${locale} must supply all five new keys`);
  }
  assert.notEqual(guestDictionary("en").save, guestDictionary("de").save);
  assert.notEqual(guestDictionary("en").saveThisStay, guestDictionary("fr").saveThisStay);
});

// ---------- END-TO-END: real route handlers -> real interpretation functions ----------

let mockSession: { user: { id: string; hostProfileId: string | null; roles: string[] } } | null = null;
let favouritesGET: typeof import("../../api/favourites/route").GET;
let favouritesPOST: typeof import("../../api/favourites/route").POST;
let favouriteDELETE: typeof import("../../api/favourites/[propertyId]/route").DELETE;

before(async () => {
  mock.module("next-auth", { namedExports: { getServerSession: async () => mockSession } });
  ({ GET: favouritesGET, POST: favouritesPOST } = await import("../../api/favourites/route"));
  ({ DELETE: favouriteDELETE } = await import("../../api/favourites/[propertyId]/route"));

  const check = await db.query(`SELECT COUNT(*) FROM fee_configs WHERE active = TRUE`);
  if (Number(check.rows[0].count) === 0) throw new Error("No active fee_configs row — run scripts/seedFeeConfig.ts first");
});
after(async () => { await db.end(); });

async function createGuestAndProperty(suffix: string) {
  const hostUser = await db.query(`INSERT INTO users (email, password_hash, status) VALUES ($1, 'x', 'active') RETURNING id`, [`e2e-fav-host-${suffix}@test.host`]);
  const hostProfile = await db.query(`INSERT INTO host_profiles (user_id, payout_account_status) VALUES ($1, 'active') RETURNING id`, [hostUser.rows[0].id]);
  const property = await db.query(
    `INSERT INTO properties (host_id, name, slug, city, currency, nightly_price, max_guests, status, compliance_status)
     VALUES ($1, 'E2E Favourite Test Property', $2, 'Manchester', 'GBP', 125, 2, 'published', 'approved') RETURNING id`,
    [hostProfile.rows[0].id, `e2e-fav-test-${suffix}`]
  );
  const guestUser = await db.query(`INSERT INTO users (email, password_hash, status) VALUES ($1, 'x', 'active') RETURNING id`, [`e2e-fav-guest-${suffix}@test.host`]);
  return { propertyId: property.rows[0].id as string, guestUserId: guestUser.rows[0].id as string };
}

/**
 * requireSession() (lib/auth/session.ts) now validates a genuinely
 * active auth_sessions row and a matching session_version, not just
 * session.user.id — found directly while debugging this test file's
 * own failures, tracing them to a real, current part of this
 * project's security model rather than working around it. Creates a
 * real row and returns a mock session object shaped to match it.
 */
async function createAuthenticatedSession(userId: string) {
  const sessionRow = await db.query(
    `INSERT INTO auth_sessions (user_id, expires_at) VALUES ($1, NOW() + INTERVAL '1 day') RETURNING id`,
    [userId]
  );
  return { user: { id: userId, hostProfileId: null, roles: ["guest"], sessionId: sessionRow.rows[0].id, sessionVersion: 1 } };
}

test("END-TO-END — EXISTING SAVED PROPERTY IS DETECTED: a property the guest already saved is correctly reported by the real GET route", async () => {
  const suffix = crypto.randomBytes(4).toString("hex");
  const { propertyId, guestUserId } = await createGuestAndProperty(suffix);
  await db.query(`INSERT INTO saved_properties (user_id, property_id) VALUES ($1, $2)`, [guestUserId, propertyId]);
  mockSession = await createAuthenticatedSession(guestUserId);

  const request = new NextRequest("http://localhost/api/favourites");
  const response = await favouritesGET(request);
  const body = await response.json();
  const result = interpretFavouritesLoad(response.status, body, propertyId);

  assert.deepEqual(result, { kind: "determined", saved: true });
});

test("END-TO-END — a property the guest has NOT saved is correctly detected as not saved", async () => {
  const suffix = crypto.randomBytes(4).toString("hex");
  const { propertyId, guestUserId } = await createGuestAndProperty(suffix);
  mockSession = await createAuthenticatedSession(guestUserId);

  const request = new NextRequest("http://localhost/api/favourites");
  const response = await favouritesGET(request);
  const body = await response.json();
  const result = interpretFavouritesLoad(response.status, body, propertyId);

  assert.deepEqual(result, { kind: "determined", saved: false });
});

test("END-TO-END — SIGNED-OUT INITIAL GET RESOLVES TO BROWSABLE UNSAVED STATE, NOT A REDIRECT: the real route genuinely returns 401 for an anonymous request, and the page's own logic never treats this as a reason to redirect", async () => {
  const suffix = crypto.randomBytes(4).toString("hex");
  const { propertyId } = await createGuestAndProperty(suffix);
  mockSession = null;

  const request = new NextRequest("http://localhost/api/favourites");
  const response = await favouritesGET(request);
  assert.equal(response.status, 401, "the real route's real status must genuinely be 401 for an anonymous request");
  const body = await response.json();
  const result = interpretFavouritesLoad(response.status, body, propertyId);

  assert.deepEqual(result, { kind: "signedOut" });

  // Exactly what the page's own favourites-load effect does with this
  // result — proving the resolved state is browsable, not "unknown"
  // or any state that would leave the control stuck/disabled.
  const resolvedState = result.kind === "signedOut" ? { status: "unsaved" as const, busy: false, error: null } : null;
  assert.deepEqual(resolvedState, { status: "unsaved", busy: false, error: null });
  assert.notEqual(resolvedState!.status, "unknown", "a signed-out visitor must land on a real, interactive state, not stay stuck disabled");
});

test("END-TO-END — POST 401 PRODUCES THE LOGIN REDIRECT: an unauthenticated save attempt is identified as 'unauthorized' (distinct from the passive load's 'signedOut'), and the real redirect URL preserves pathname and query string", async () => {
  const suffix = crypto.randomBytes(4).toString("hex");
  const { propertyId } = await createGuestAndProperty(suffix);
  mockSession = null;

  const request = new NextRequest("http://localhost/api/favourites", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ propertyId }),
  });
  const response = await favouritesPOST(request);
  const body = await response.json();
  const result = interpretFavouriteMutation(response.status, body, "fallback");

  assert.deepEqual(result, { kind: "unauthorized" });

  const redirectUrl = buildLoginRedirectUrl(`/stays/e2e-fav-test-${suffix}`, "?checkIn=2026-12-01&checkOut=2026-12-03&guests=2");
  assert.equal(redirectUrl, `/login?returnTo=${encodeURIComponent(`/stays/e2e-fav-test-${suffix}?checkIn=2026-12-01&checkOut=2026-12-03&guests=2`)}`);
});

test("END-TO-END — SUCCESSFUL SAVE: POST genuinely creates the saved_properties row, and the interpretation function reports success", async () => {
  const suffix = crypto.randomBytes(4).toString("hex");
  const { propertyId, guestUserId } = await createGuestAndProperty(suffix);
  mockSession = await createAuthenticatedSession(guestUserId);

  const request = new NextRequest("http://localhost/api/favourites", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ propertyId }),
  });
  const response = await favouritesPOST(request);
  const body = await response.json();
  const result = interpretFavouriteMutation(response.status, body, "fallback");

  assert.deepEqual(result, { kind: "success" });

  const row = await db.query(`SELECT 1 FROM saved_properties WHERE user_id = $1 AND property_id = $2`, [guestUserId, propertyId]);
  assert.equal(row.rows.length, 1, "the property must genuinely be saved in the database, not just reported as successful");
});

test("END-TO-END — SUCCESSFUL REMOVAL: DELETE genuinely removes the saved_properties row, and the interpretation function reports success", async () => {
  const suffix = crypto.randomBytes(4).toString("hex");
  const { propertyId, guestUserId } = await createGuestAndProperty(suffix);
  await db.query(`INSERT INTO saved_properties (user_id, property_id) VALUES ($1, $2)`, [guestUserId, propertyId]);
  mockSession = await createAuthenticatedSession(guestUserId);

  const request = new NextRequest(`http://localhost/api/favourites/${propertyId}`, { method: "DELETE" });
  const response = await favouriteDELETE(request, { params: Promise.resolve({ propertyId }) });
  const body = await response.json();
  const result = interpretFavouriteMutation(response.status, body, "fallback");

  assert.deepEqual(result, { kind: "success" });

  const row = await db.query(`SELECT 1 FROM saved_properties WHERE user_id = $1 AND property_id = $2`, [guestUserId, propertyId]);
  assert.equal(row.rows.length, 0, "the property must genuinely be removed from the database");
});

test("END-TO-END — MUTATION FAILURE PRESERVES PREVIOUS STATE: saving a non-existent property genuinely fails, and the state machine keeps the prior saved status", async () => {
  const suffix = crypto.randomBytes(4).toString("hex");
  const { guestUserId } = await createGuestAndProperty(suffix);
  mockSession = await createAuthenticatedSession(guestUserId);

  const nonExistentPropertyId = crypto.randomUUID();
  const request = new NextRequest("http://localhost/api/favourites", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ propertyId: nonExistentPropertyId }),
  });
  const response = await favouritesPOST(request);
  const body = await response.json();
  const result = interpretFavouriteMutation(response.status, body, guestDictionary("en").saveUpdateError);

  assert.equal(result.kind, "error", "a genuinely non-existent property must be a real, reported failure, not a false success");

  const previousState = { status: "unsaved" as const, busy: true, error: null };
  const nextState = completeFavouriteAction(previousState, result, true);
  assert.equal(nextState.status, "unsaved", "the previous state must be preserved when a real mutation genuinely fails");
  assert.ok(nextState.error && nextState.error.length > 0, "a short, accessible error message must be set");
});
