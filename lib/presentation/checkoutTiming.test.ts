import test from "node:test";
import assert from "node:assert/strict";
import { isChargeDeferred } from "./checkoutTiming";

const NOW = new Date("2026-08-28T12:00:00.000Z").getTime();

test("future persisted scheduled-charge dates are described as deferred", () => {
  assert.equal(isChargeDeferred("2026-11-19T00:00:00.000Z", NOW), true);
});

test("a due or past scheduled-charge date is described as an immediate charge", () => {
  assert.equal(isChargeDeferred("2026-08-28T12:00:00.000Z", NOW), false);
  assert.equal(isChargeDeferred("2026-08-27T12:00:00.000Z", NOW), false);
});

test("missing or malformed dates fail closed to immediate-charge wording", () => {
  assert.equal(isChargeDeferred(null, NOW), false);
  assert.equal(isChargeDeferred("not-a-date", NOW), false);
});
