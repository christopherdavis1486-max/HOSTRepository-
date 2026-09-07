import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "crypto";
import { db } from "../db";
import { createPropertyForHost, updatePropertyForHost, getHostPropertyDetail, listAllAmenities } from "./hostProperties";

async function createTestHost(suffix: string) {
  const hostUser = await db.query(`INSERT INTO users (email, password_hash, status) VALUES ($1, 'x', 'active') RETURNING id`, [`h5-host-${suffix}@test.host`]);
  const hostProfile = await db.query(`INSERT INTO host_profiles (user_id, payout_account_status) VALUES ($1, 'active') RETURNING id`, [hostUser.rows[0].id]);
  return hostProfile.rows[0].id as string;
}

before(async () => {
  const check = await db.query(`SELECT COUNT(*) FROM fee_configs WHERE active = TRUE`);
  if (Number(check.rows[0].count) === 0) throw new Error("No active fee_configs row — run scripts/seedFeeConfig.ts first");
  const amenityCheck = await db.query(`SELECT COUNT(*) FROM amenities`);
  if (Number(amenityCheck.rows[0].count) === 0) throw new Error("No amenities seeded — run migrations/009_amenities.sql first");
});
after(async () => { await db.end(); });

test("creating a property defaults to draft status when none is specified", async () => {
  const suffix = crypto.randomBytes(4).toString("hex");
  const hostId = await createTestHost(suffix);
  const propertyId = await createPropertyForHost(hostId, {
    name: "Test Property", city: "Liverpool", maxGuests: 2, bedrooms: 1, bathrooms: 1, nightlyPrice: 100,
  });
  const detail = await getHostPropertyDetail(propertyId);
  assert.equal(detail!.status, "draft");
});

test("a created property gets a real, unique slug derived from its name", async () => {
  const suffix = crypto.randomBytes(4).toString("hex");
  const hostId = await createTestHost(suffix);
  const propertyId = await createPropertyForHost(hostId, {
    name: "Riverside Apartment", city: "Liverpool", maxGuests: 2, bedrooms: 1, bathrooms: 1, nightlyPrice: 100,
  });
  const detail = await getHostPropertyDetail(propertyId);
  assert.ok(detail!.slug!.startsWith("riverside-apartment-"));
});

test("two properties with the same name get different slugs, no collision", async () => {
  const suffix = crypto.randomBytes(4).toString("hex");
  const hostId = await createTestHost(suffix);
  const id1 = await createPropertyForHost(hostId, { name: "Same Name", city: "Liverpool", maxGuests: 2, bedrooms: 1, bathrooms: 1, nightlyPrice: 100 });
  const id2 = await createPropertyForHost(hostId, { name: "Same Name", city: "Liverpool", maxGuests: 2, bedrooms: 1, bathrooms: 1, nightlyPrice: 100 });
  const d1 = await getHostPropertyDetail(id1);
  const d2 = await getHostPropertyDetail(id2);
  assert.notEqual(d1!.slug, d2!.slug);
});

test("creating a property with amenities correctly associates them", async () => {
  const suffix = crypto.randomBytes(4).toString("hex");
  const hostId = await createTestHost(suffix);
  const allAmenities = await listAllAmenities();
  const wifi = allAmenities.find((a) => a.slug === "wifi")!;
  const kitchen = allAmenities.find((a) => a.slug === "kitchen")!;

  const propertyId = await createPropertyForHost(hostId, {
    name: "Amenity Test", city: "Liverpool", maxGuests: 2, bedrooms: 1, bathrooms: 1, nightlyPrice: 100,
    amenityIds: [wifi.id, kitchen.id],
  });
  const detail = await getHostPropertyDetail(propertyId);
  const amenitySlugs = detail!.amenities.map((a: any) => a.slug).sort();
  assert.deepEqual(amenitySlugs, ["kitchen", "wifi"]);
});

test("REGRESSION: select Wi-Fi + Kitchen, save via the real schema-validated payload, fresh read shows both", async () => {
  // Reproduces the exact real defect, not a hypothetical: the PATCH
  // payload here is the EXACT shape app/host/properties/[id]/page.tsx's
  // real handleSave() sends — including empty-string placeholders for
  // unset optional fields (propertyType, district, countryCode), which
  // is what the real frontend form does whenever those fields aren't
  // filled in. Before the fix, updatePropertySchema.safeParse() on this
  // exact payload FAILED (propertyType/countryCode's lower-bound length
  // checks rejected the empty strings), so the whole PATCH request never
  // reached updatePropertyForHost() at all — amenities were never even
  // attempted, let alone saved. A test that only exercised
  // updatePropertyForHost() directly (bypassing schema validation, as
  // this file's other amenity tests correctly and separately do) would
  // NOT have caught this — the bug lived in the validation layer, not
  // the database functions, which is why this test goes through the
  // real schema first.
  const suffix = crypto.randomBytes(4).toString("hex");
  const hostId = await createTestHost(suffix);
  const propertyId = await createPropertyForHost(hostId, {
    name: "Regression Test Property", city: "Liverpool", maxGuests: 2, bedrooms: 1, bathrooms: 1, nightlyPrice: 100,
  });
  const allAmenities = await listAllAmenities();
  const wifi = allAmenities.find((a) => a.slug === "wifi")!;
  const kitchen = allAmenities.find((a) => a.slug === "kitchen")!;

  const { updatePropertySchema } = await import("../validation/schemas");
  const realFormPayload = {
    name: "Regression Test Property", propertyType: "", description: "", city: "Liverpool", district: "", countryCode: "",
    maxGuests: 2, bedrooms: 1, bathrooms: 1, nightlyPrice: 100, cleaningFee: 0,
    checkInTime: "15:00", checkOutTime: "11:00", houseRules: "", status: "draft",
    amenityIds: [wifi.id, kitchen.id],
  };

  const parsed = updatePropertySchema.safeParse(realFormPayload);
  assert.equal(parsed.success, true, "the real frontend's payload shape (with empty-string unset fields) must validate successfully — this is exactly what was broken");
  if (!parsed.success) return;

  await updatePropertyForHost(propertyId, parsed.data);

  const freshRead = await getHostPropertyDetail(propertyId);
  const slugs = freshRead!.amenities.map((a: any) => a.slug).sort();
  assert.deepEqual(slugs, ["kitchen", "wifi"], "both amenities must survive a fresh read after save, going through the real validation layer");
});

test("removing one amenity (Kitchen) while keeping Wi-Fi persists correctly through the real schema", async () => {
  const suffix = crypto.randomBytes(4).toString("hex");
  const hostId = await createTestHost(suffix);
  const allAmenities = await listAllAmenities();
  const wifi = allAmenities.find((a) => a.slug === "wifi")!;
  const kitchen = allAmenities.find((a) => a.slug === "kitchen")!;

  const propertyId = await createPropertyForHost(hostId, {
    name: "Removal Test", city: "Liverpool", maxGuests: 2, bedrooms: 1, bathrooms: 1, nightlyPrice: 100,
    amenityIds: [wifi.id, kitchen.id],
  });

  const { updatePropertySchema } = await import("../validation/schemas");
  const parsed = updatePropertySchema.safeParse({
    name: "Removal Test", propertyType: "", description: "", city: "Liverpool", district: "", countryCode: "",
    maxGuests: 2, bedrooms: 1, bathrooms: 1, nightlyPrice: 100, cleaningFee: 0,
    checkInTime: "15:00", checkOutTime: "11:00", houseRules: "", status: "draft",
    amenityIds: [wifi.id], // Kitchen removed
  });
  assert.equal(parsed.success, true);
  if (!parsed.success) return;

  await updatePropertyForHost(propertyId, parsed.data);
  const freshRead = await getHostPropertyDetail(propertyId);
  assert.deepEqual(freshRead!.amenities.map((a: any) => a.slug), ["wifi"], "Kitchen must be gone, Wi-Fi must remain");
});

test("saving an empty amenity list clears the full set — the intended checkbox semantics", async () => {
  const suffix = crypto.randomBytes(4).toString("hex");
  const hostId = await createTestHost(suffix);
  const allAmenities = await listAllAmenities();
  const wifi = allAmenities.find((a) => a.slug === "wifi")!;

  const propertyId = await createPropertyForHost(hostId, {
    name: "Clear Test", city: "Liverpool", maxGuests: 2, bedrooms: 1, bathrooms: 1, nightlyPrice: 100,
    amenityIds: [wifi.id],
  });

  const { updatePropertySchema } = await import("../validation/schemas");
  const parsed = updatePropertySchema.safeParse({
    name: "Clear Test", propertyType: "", description: "", city: "Liverpool", district: "", countryCode: "",
    maxGuests: 2, bedrooms: 1, bathrooms: 1, nightlyPrice: 100, cleaningFee: 0,
    checkInTime: "15:00", checkOutTime: "11:00", houseRules: "", status: "draft",
    amenityIds: [], // all unchecked
  });
  assert.equal(parsed.success, true);
  if (!parsed.success) return;

  await updatePropertyForHost(propertyId, parsed.data);
  const freshRead = await getHostPropertyDetail(propertyId);
  assert.deepEqual(freshRead!.amenities, [], "an empty amenityIds array must clear the full set, matching how a checkbox form submits 'nothing checked'");
});

test("cross-host modification remains forbidden — a different host's session cannot change another host's amenities", async () => {
  const suffixA = crypto.randomBytes(4).toString("hex");
  const suffixB = crypto.randomBytes(4).toString("hex");
  const hostA = await createTestHost(suffixA);
  const hostB = await createTestHost(suffixB);
  const allAmenities = await listAllAmenities();
  const wifi = allAmenities.find((a) => a.slug === "wifi")!;

  const propertyId = await createPropertyForHost(hostA, {
    name: "Cross Host Test", city: "Liverpool", maxGuests: 2, bedrooms: 1, bathrooms: 1, nightlyPrice: 100,
  });

  const { resolveHostPropertyAccess } = await import("../auth/hostAccess");
  const { AuthError } = await import("../auth/session");
  const hostBUser = await db.query(`SELECT user_id FROM host_profiles WHERE id = $1`, [hostB]);

  await assert.rejects(
    () => resolveHostPropertyAccess({ user: { id: hostBUser.rows[0].user_id, roles: ["host"], hostProfileId: hostB } } as any, propertyId),
    (err: unknown) => err instanceof AuthError && err.status === 403
  );

  // Confirm the property's amenities were never touched by the rejected attempt.
  const detail = await getHostPropertyDetail(propertyId);
  assert.deepEqual(detail!.amenities, []);
});

test("a partial update only touches the fields provided, leaving everything else intact", async () => {
  const suffix = crypto.randomBytes(4).toString("hex");
  const hostId = await createTestHost(suffix);
  const propertyId = await createPropertyForHost(hostId, {
    name: "Original Name", city: "Liverpool", description: "Original description",
    maxGuests: 2, bedrooms: 1, bathrooms: 1, nightlyPrice: 100,
  });

  await updatePropertyForHost(propertyId, { nightlyPrice: 150 });

  const detail = await getHostPropertyDetail(propertyId);
  assert.equal(Number(detail!.nightlyPrice), 150, "the changed field must reflect the update");
  assert.equal(detail!.name, "Original Name", "an untouched field must survive a partial update unchanged");
  assert.equal(detail!.description, "Original description");
});

test("updating amenities replaces the full set, not merges with it", async () => {
  const suffix = crypto.randomBytes(4).toString("hex");
  const hostId = await createTestHost(suffix);
  const allAmenities = await listAllAmenities();
  const wifi = allAmenities.find((a) => a.slug === "wifi")!;
  const parking = allAmenities.find((a) => a.slug === "parking")!;

  const propertyId = await createPropertyForHost(hostId, {
    name: "Replace Test", city: "Liverpool", maxGuests: 2, bedrooms: 1, bathrooms: 1, nightlyPrice: 100,
    amenityIds: [wifi.id],
  });

  await updatePropertyForHost(propertyId, { amenityIds: [parking.id] });

  const detail = await getHostPropertyDetail(propertyId);
  const slugs = detail!.amenities.map((a: any) => a.slug);
  assert.deepEqual(slugs, ["parking"], "wifi must be gone, replaced entirely by parking, not merged");
});

test("changing status to published then back to draft/paused works, and each status is stored literally", async () => {
  const suffix = crypto.randomBytes(4).toString("hex");
  const hostId = await createTestHost(suffix);
  const propertyId = await createPropertyForHost(hostId, {
    name: "Status Test", city: "Liverpool", maxGuests: 2, bedrooms: 1, bathrooms: 1, nightlyPrice: 100,
  });

  await updatePropertyForHost(propertyId, { status: "published" });
  assert.equal((await getHostPropertyDetail(propertyId))!.status, "published");

  await updatePropertyForHost(propertyId, { status: "paused" });
  assert.equal((await getHostPropertyDetail(propertyId))!.status, "paused");
});

test("a published property is publicly visible via the same query the public route uses", async () => {
  const suffix = crypto.randomBytes(4).toString("hex");
  const hostId = await createTestHost(suffix);
  const propertyId = await createPropertyForHost(hostId, {
    name: "Public Visibility Test", city: "Liverpool", maxGuests: 2, bedrooms: 1, bathrooms: 1, nightlyPrice: 100, status: "published",
  });
  const publicRow = await db.query(`SELECT status FROM properties WHERE id = $1 AND status = 'published'`, [propertyId]);
  assert.equal(publicRow.rows.length, 1);
});

test("a draft property is correctly excluded from the public-visible filter", async () => {
  const suffix = crypto.randomBytes(4).toString("hex");
  const hostId = await createTestHost(suffix);
  const propertyId = await createPropertyForHost(hostId, {
    name: "Draft Visibility Test", city: "Liverpool", maxGuests: 2, bedrooms: 1, bathrooms: 1, nightlyPrice: 100,
  });
  const publicRow = await db.query(`SELECT status FROM properties WHERE id = $1 AND status = 'published'`, [propertyId]);
  assert.equal(publicRow.rows.length, 0, "a draft property must never match the public route's own status='published' filter");
});
