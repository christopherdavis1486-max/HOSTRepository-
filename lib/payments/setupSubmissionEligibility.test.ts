import test from "node:test";
import assert from "node:assert/strict";
import { isSetupSubmissionEligible } from "./setupSubmissionEligibility";

const active = {
  status: "pending_payment",
  payment_flow_version: "separate_charges_delayed_v1",
  archived_at: null,
  stripe_customer_id: "cus_fixture",
  stripe_setup_intent_id: "seti_fixture",
  stripe_payment_method_id: null,
  grace_period_started_at: null,
  setup_hold_active: true,
  has_any_payment_attempt: false,
  has_unresolved_setup_creation: false,
  has_legacy_payment: false,
  has_successful_attempt: false,
  has_entitlement: false,
};

test("initial saved-card setup is eligible with complete evidence", () => {
  assert.equal(isSetupSubmissionEligible(active), true);
});

test("inactive bookings, saved cards and existing financial activity block setup", () => {
  const blocked = [
    { status: "cancelled" }, { status: "confirmed" },
    { status: "completed" }, { status: "refunded" },
    { payment_flow_version: "destination_charge_legacy" },
    { archived_at: "2026-11-20" },
    { stripe_customer_id: null }, { stripe_setup_intent_id: null },
    { stripe_customer_id: "" }, { stripe_setup_intent_id: "" },
    { stripe_payment_method_id: "pm_saved" },
    { grace_period_started_at: "2026-11-20" },
    { setup_hold_active: false },
    { has_any_payment_attempt: true },
    { has_unresolved_setup_creation: true },
    { has_legacy_payment: true },
    { has_successful_attempt: true },
    { has_entitlement: true },
  ];
  for (const override of blocked) {
    assert.equal(isSetupSubmissionEligible({ ...active, ...override }), false,
      JSON.stringify(override));
  }
});

test("missing or uncertain eligibility evidence fails closed", () => {
  for (const key of Object.keys(active)) {
    assert.equal(isSetupSubmissionEligible({ ...active, [key]: undefined }), false, key);
  }
  for (const key of [
    "setup_hold_active", "has_any_payment_attempt",
    "has_unresolved_setup_creation", "has_legacy_payment",
    "has_successful_attempt", "has_entitlement",
  ]) {
    assert.equal(isSetupSubmissionEligible({ ...active, [key]: null }), false, key);
  }
});

test("display labels cannot override an existing payment attempt", () => {
  for (const guestPaymentStatus of [
    "payment_method_required", "payment_method_saved",
    "payment_grace_period", "payment_scheduled",
  ]) {
    const row = { ...active, has_any_payment_attempt: true, guestPaymentStatus };
    assert.equal(isSetupSubmissionEligible(row), false);
  }
});
