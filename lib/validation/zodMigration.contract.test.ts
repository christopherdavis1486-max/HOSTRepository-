import { test } from "node:test";
import assert from "node:assert/strict";
import {
  hostOnboardingStartSchema,
  adminRefundSchema,
  updatePropertySchema,
  registerSchema,
  validationErrorResponse
} from "./schemas";
import { roomTypeSchema, hotelDate } from "../hotels/schemas";
import { createCalendarFeedSchema } from "../calendar/calendarSchemas";

const id = "b7d31e72-c0a1-406a-b46b-635769e04939";

test("validation contract: explicit consent and custom messages", () => {
  for (const [field, message] of [
    ["hostAgreementAccepted", "You must accept the HOST host agreement before continuing"],
    ["defaultPoliciesAccepted", "You must accept HOST's default pilot policies before continuing"]
  ] as const) {
    for (const value of [undefined, false, "true"]) {
      const result = hostOnboardingStartSchema.safeParse({
        country: "GB", hostAgreementAccepted: true,
        defaultPoliciesAccepted: true, [field]: value
      });
      assert.equal(result.success, false);
      if (result.success) throw new Error("Invalid consent accepted");
      assert.ok(result.error.issues.some(issue =>
        issue.path[0] === field && issue.message === message));
      assert.match(validationErrorResponse(result.error).error.message,
        /before continuing/);
    }
  }
  assert.deepEqual(hostOnboardingStartSchema.parse({
    country: " gb ", hostAgreementAccepted: true,
    defaultPoliciesAccepted: true, roles: ["admin"]
  }), {
    country: "GB", hostAgreementAccepted: true, defaultPoliciesAccepted: true
  });
});

test("validation contract: refund amount and reason restrictions", () => {
  assert.equal(adminRefundSchema.safeParse({
    bookingId: id, amountMinor: 100, reason: "admin_goodwill"
  }).success, true);
  for (const amountMinor of [0, -1, 1.5, "100"]) {
    assert.equal(adminRefundSchema.safeParse({
      bookingId: id, amountMinor, reason: "admin_goodwill"
    }).success, false);
  }
  const result = adminRefundSchema.safeParse({
    bookingId: id, amountMinor: 100, reason: "unknown"
  });
  assert.equal(result.success, false);
  if (result.success) throw new Error("Unknown reason accepted");
  assert.ok(result.error.issues.some(issue => issue.message ===
    "reason must be one of admin_goodwill, dispute, host_cancellation, pricing_error"));
});

test("validation contract: partial updates preserve omitted fields", () => {
  assert.deepEqual(updatePropertySchema.parse({}), {});
  assert.deepEqual(updatePropertySchema.parse({
    postcode: " l1 1aa ", latitude: "53.4073", longitude: "-2.9836"
  }), { postcode: "L1 1AA", latitude: 53.4073, longitude: -2.9836 });
  assert.deepEqual(updatePropertySchema.parse({
    latitude: "", longitude: ""
  }), { latitude: null, longitude: null });
  assert.equal(updatePropertySchema.safeParse({ latitude: 53 }).success, false);
  assert.equal(updatePropertySchema.safeParse({
    latitude: 91, longitude: 0
  }).success, false);
  assert.equal(updatePropertySchema.safeParse({
    minStayNights: 5, maxStayNights: 2
  }).success, false);
});

test("validation contract: room defaults and strict fields", () => {
  const input = {
    name: " Test Double ", maxGuests: 2, totalRooms: 3, nightlyPrice: 100
  };
  assert.deepEqual(roomTypeSchema.parse(input), {
    name: "Test Double", description: "", maxGuests: 2, totalRooms: 3,
    nightlyPrice: 100, cleaningFee: 0, active: true, imageIds: []
  });
  assert.equal(roomTypeSchema.safeParse({ ...input, hostId: id }).success, false);
  assert.equal(roomTypeSchema.safeParse({ ...input, totalRooms: 0 }).success, false);
});

test("validation contract: calendar dates and HTTPS restrictions", () => {
  assert.equal(hotelDate.safeParse("2028-02-29").success, true);
  assert.equal(hotelDate.safeParse("2027-02-29").success, false);
  assert.equal(createCalendarFeedSchema.safeParse({
    name: "Fixture", feedUrl: "https://example.test/calendar.ics"
  }).success, true);
  for (const feedUrl of [
    "http://example.test/calendar.ics",
    "https://user:password@example.test/calendar.ics",
    "https://example.test:444/calendar.ics"
  ]) {
    assert.equal(createCalendarFeedSchema.safeParse({
      name: "Fixture", feedUrl
    }).success, false);
  }
});

test("validation contract: registration normalization and error response", () => {
  assert.deepEqual(registerSchema.parse({
    email: " Fixture@Example.test ", password: "FixturePassword123"
  }), { email: "fixture@example.test", password: "FixturePassword123" });
  const result = registerSchema.safeParse({
    email: "invalid", password: "short"
  });
  assert.equal(result.success, false);
  if (result.success) throw new Error("Invalid registration accepted");
  const response = validationErrorResponse(result.error);
  assert.equal(response.success, false);
  assert.equal(response.error.code, "INVALID_INPUT");
  assert.match(response.error.message, /email: Enter a valid email address/);
  assert.match(response.error.message, /password: Password must be at least 12 characters/);
});
