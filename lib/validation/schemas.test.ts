import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createBookingSchema,
  createPropertySchema,
  hostOnboardingStartSchema,
  updatePropertySchema,
} from "./schemas";

const validBase = {
  propertyId: "00000000-0000-0000-0000-000000000000",
  guests: 2,
  guestName: "Test Guest",
  guestEmail: "test@example.com",
};

const validProperty = {
  name: "Test Apartment",
  city: "Liverpool",
  countryCode: "GB",
  maxGuests: 2,
  bedrooms: 1,
  bathrooms: 1,
  nightlyPrice: 100,
};

function isoPlusDays(days: number): string {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

test("past check-in date is rejected", () => {
  const result = createBookingSchema.safeParse({
    ...validBase,
    checkIn: isoPlusDays(-5),
    checkOut: isoPlusDays(-3),
  });

  assert.equal(result.success, false);

  if (!result.success) {
    assert.ok(
      result.error.issues.some((issue) =>
        issue.message.includes("cannot be in the past")
      )
    );
  }
});

test("today's date as check-in is accepted", () => {
  const result = createBookingSchema.safeParse({
    ...validBase,
    checkIn: isoPlusDays(0),
    checkOut: isoPlusDays(2),
  });

  assert.equal(result.success, true);
});

test("a check-in within the 12-month horizon is accepted", () => {
  const result = createBookingSchema.safeParse({
    ...validBase,
    checkIn: isoPlusDays(300),
    checkOut: isoPlusDays(302),
  });

  assert.equal(result.success, true);
});

test("a check-in beyond 12 months is rejected", () => {
  const result = createBookingSchema.safeParse({
    ...validBase,
    checkIn: isoPlusDays(400),
    checkOut: isoPlusDays(402),
  });

  assert.equal(result.success, false);

  if (!result.success) {
    assert.ok(
      result.error.issues.some((issue) =>
        issue.message.includes("12 months")
      )
    );
  }
});

test("a check-in exactly at the 12-month boundary is accepted", () => {
  const date = new Date();
  date.setUTCMonth(date.getUTCMonth() + 12);

  const checkIn = date.toISOString().slice(0, 10);
  const checkOutDate = new Date(date);
  checkOutDate.setUTCDate(checkOutDate.getUTCDate() + 2);

  const result = createBookingSchema.safeParse({
    ...validBase,
    checkIn,
    checkOut: checkOutDate.toISOString().slice(0, 10),
  });

  assert.equal(result.success, true);
});

test("checkOut must still be after checkIn", () => {
  const result = createBookingSchema.safeParse({
    ...validBase,
    checkIn: isoPlusDays(10),
    checkOut: isoPlusDays(5),
  });

  assert.equal(result.success, false);
});

test("GB host onboarding is accepted", () => {
  const result = hostOnboardingStartSchema.safeParse({
    country: "GB",
  });

  assert.equal(result.success, true);
});

test("lowercase gb is normalised and accepted", () => {
  const result = hostOnboardingStartSchema.safeParse({
    country: "gb",
  });

  assert.equal(result.success, true);

  if (result.success) {
    assert.equal(result.data.country, "GB");
  }
});

test("non-GB host onboarding is rejected during the pilot", () => {
  const result = hostOnboardingStartSchema.safeParse({
    country: "DE",
  });

  assert.equal(result.success, false);
});

test("valid property stay limits and cancellation policy are accepted", () => {
  const result = createPropertySchema.safeParse({
    ...validProperty,
    minStayNights: 2,
    maxStayNights: 28,
    cancellationPolicyId: "00000000-0000-4000-8000-000000000001",
  });

  assert.equal(result.success, true);
});

test("create property rejects a minimum stay above its maximum stay", () => {
  const result = createPropertySchema.safeParse({
    ...validProperty,
    minStayNights: 14,
    maxStayNights: 7,
  });

  assert.equal(result.success, false);

  if (!result.success) {
    assert.ok(
      result.error.issues.some(
        (issue) =>
          issue.path[0] === "maxStayNights" &&
          issue.message.includes("greater than or equal")
      )
    );
  }
});

test("update property rejects a minimum stay above its maximum stay", () => {
  const result = updatePropertySchema.safeParse({
    minStayNights: 30,
    maxStayNights: 5,
  });

  assert.equal(result.success, false);
});

test("stay limits outside 1 to 365 nights are rejected", () => {
  assert.equal(
    createPropertySchema.safeParse({
      ...validProperty,
      minStayNights: 0,
      maxStayNights: 20,
    }).success,
    false
  );

  assert.equal(
    createPropertySchema.safeParse({
      ...validProperty,
      minStayNights: 1,
      maxStayNights: 366,
    }).success,
    false
  );
});

test("an invalid cancellation policy ID is rejected", () => {
  const result = createPropertySchema.safeParse({
    ...validProperty,
    cancellationPolicyId: "not-a-uuid",
  });

  assert.equal(result.success, false);
});

test("an empty cancellation policy selection is accepted as undefined", () => {
  const result = createPropertySchema.safeParse({
    ...validProperty,
    cancellationPolicyId: "",
  });

  assert.equal(result.success, true);

  if (result.success) {
    assert.equal(result.data.cancellationPolicyId, undefined);
  }
});