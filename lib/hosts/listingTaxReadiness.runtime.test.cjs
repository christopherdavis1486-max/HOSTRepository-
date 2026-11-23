
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const { stripTypeScriptTypes } = require("node:module");

const raw = fs.readFileSync("lib/hosts/listingReadiness.ts", "utf8");
const code = stripTypeScriptTypes(raw.replace(/^import .*;\r?\n/gm, ""), { mode: "transform" })
  .replace(/\bexport\s+(?=(?:async\s+)?(?:function|class|const))/g, "");

function fixture(type) {
  return {
    id: "tax-fixture", name: "Test property", property_type: type,
    description: "Test description", city: "Liverpool", country_code: "GB",
    max_guests: 2, bedrooms: 1, bathrooms: 1,
    nightly_price: "100", currency: "GBP",
    min_stay_nights: 1, max_stay_nights: 365,
    cancellation_policy_id: "policy", check_in_time: "15:00",
    check_out_time: "11:00", address_line_1: "Test address",
    postal_town: "Liverpool", postcode: "L1 0AA",
    has_private_location: true, has_public_location: true,
    image_count: 3, cover_count: 1,
    host_agreement_version: "pilot-2026-09",
    host_agreement_accepted_at: "2026-01-01",
    default_policies_accepted_at: "2026-01-01",
    payout_account_status: "active", compliance_status: "approved",
    compliance_item_count: 1, incomplete_compliance_count: 0,
    expired_compliance_count: 0, pilot_review_status: "approved",
    accommodation_vat_rate: "0.0000", cleaning_vat_rate: "0.0000",
    active_room_count: 1, incomplete_room_count: 0,
  };
}

function harness(row) {
  const writes = [];
  const db = { query: async sql => {
    if (/^SELECT id\s+FROM properties/.test(sql.trim()))
      return { rows: [{id: row.id}], rowCount: 1 };
    if (/^SELECT\s/.test(sql.trim())) return {rows: [row], rowCount: 1};
    writes.push(sql);
    throw new Error("Unexpected write");
  }};
  const context = vm.createContext({
    db, withTransaction: fn => fn(db),
  });
  vm.runInContext(code +
    "\nthis.api = {getListingReadiness, assertListingReady, reviewPilotListing};",
    context);
  return {api: context.api, writes};
}

for (const type of ["Apartment", "Hotel", "Aparthotel"]) {
  for (const field of ["accommodation_vat_rate", "cleaning_vat_rate"]) {
    test(type + " missing " + field + " blocks publication and pilot approval", async () => {
      const row = {...fixture(type), [field]: null};
      const {api, writes} = harness(row);
      const report = await api.getListingReadiness(row.id);
      assert.equal(report.ready, false);
      assert.ok(report.missing.some(c => c.key === "taxSettings"));
      await assert.rejects(api.assertListingReady(row.id),
        e => e.code === "LISTING_NOT_READY");
      await assert.rejects(api.reviewPilotListing(row.id, "reviewer", "approved", "test"),
        e => e.code === "LISTING_NOT_READY");
      assert.equal(writes.length, 0);
      assert.equal(row[field], null);
    });
  }
  for (const rate of [0, "0.0000", "0.2000"]) {
    test(type + " explicitly configured rates accepted: " + rate, async () => {
      const row = {...fixture(type), accommodation_vat_rate: rate, cleaning_vat_rate: rate};
      const {api, writes} = harness(row);
      const report = await api.assertListingReady(row.id);
      assert.equal(report.ready, true);
      assert.equal(report.checks.find(c => c.key === "taxSettings").ready, true);
      assert.equal(writes.length, 0);
    });
  }
}
