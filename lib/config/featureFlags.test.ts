import { test } from "node:test";
import assert from "node:assert/strict";
import { isDelayedChargeBookingCreationEnabled, isAutomatedOffSessionChargingEnabled, isHostTransferExecutionEnabled } from "./featureFlags";

test("all three flags default OFF when their env vars are genuinely unset", () => {
  delete process.env.ENABLE_DELAYED_CHARGE_BOOKINGS;
  delete process.env.ENABLE_AUTOMATED_OFFSESSION_CHARGING;
  delete process.env.ENABLE_HOST_TRANSFER_EXECUTION;
  assert.equal(isDelayedChargeBookingCreationEnabled(), false);
  assert.equal(isAutomatedOffSessionChargingEnabled(), false);
  assert.equal(isHostTransferExecutionEnabled(), false);
});

test("only the exact string 'true' enables a flag — fail-closed against near-miss values", () => {
  for (const nearMiss of ["1", "yes", "TRUE", "True", " true", "true "]) {
    process.env.ENABLE_DELAYED_CHARGE_BOOKINGS = nearMiss;
    assert.equal(isDelayedChargeBookingCreationEnabled(), false, `"${nearMiss}" must not enable the flag`);
  }
  delete process.env.ENABLE_DELAYED_CHARGE_BOOKINGS;
});

test("setting the exact string 'true' genuinely enables the flag", () => {
  process.env.ENABLE_DELAYED_CHARGE_BOOKINGS = "true";
  assert.equal(isDelayedChargeBookingCreationEnabled(), true);
  delete process.env.ENABLE_DELAYED_CHARGE_BOOKINGS;
});

test("host-transfer execution remains OFF even when the other two flags are both ON", () => {
  process.env.ENABLE_DELAYED_CHARGE_BOOKINGS = "true";
  process.env.ENABLE_AUTOMATED_OFFSESSION_CHARGING = "true";
  delete process.env.ENABLE_HOST_TRANSFER_EXECUTION;

  assert.equal(isDelayedChargeBookingCreationEnabled(), true);
  assert.equal(isAutomatedOffSessionChargingEnabled(), true);
  assert.equal(isHostTransferExecutionEnabled(), false, "host-transfer execution must remain independently off regardless of the other two flags");

  delete process.env.ENABLE_DELAYED_CHARGE_BOOKINGS;
  delete process.env.ENABLE_AUTOMATED_OFFSESSION_CHARGING;
});

test("each flag is genuinely independent — enabling one does not enable another", () => {
  process.env.ENABLE_HOST_TRANSFER_EXECUTION = "true";
  assert.equal(isHostTransferExecutionEnabled(), true);
  assert.equal(isDelayedChargeBookingCreationEnabled(), false);
  assert.equal(isAutomatedOffSessionChargingEnabled(), false);
  delete process.env.ENABLE_HOST_TRANSFER_EXECUTION;
});
