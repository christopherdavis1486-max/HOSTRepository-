import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

function read(relativePath: string): string {
  return fs.readFileSync(
    path.join(process.cwd(), relativePath),
    "utf8"
  );
}

test("host property editor displays listing-readiness progress", () => {
  const page = read(
    "app/host/properties/[id]/page.tsx"
  );
  const panel = read(
    "components/ListingReadinessPanel.tsx"
  );

  assert.ok(
    page.includes("ListingReadinessPanel")
  );
  assert.ok(
    page.includes(
      "<ListingReadinessPanel propertyId={propertyId}"
    )
  );
  assert.ok(
    panel.includes(
      "/readiness"
    )
  );
  assert.ok(
    panel.includes("report.checks.map")
  );
  assert.ok(
    panel.includes("Refresh progress")
  );
});

test("host guidance explains manual review and links to corrective actions", () => {
  const panel = read(
    "components/ListingReadinessPanel.tsx"
  );

  assert.ok(
    panel.includes(
      "HOST must manually review"
    )
  );
  assert.ok(
    panel.includes(
      "/compliance"
    )
  );
  assert.ok(
    panel.includes(
      "/host/onboarding/connect-account"
    )
  );
  assert.ok(
    panel.includes(
      "waiting for HOST's final pilot review"
    )
  );
});

test("admin pilot-review page renders every readiness check", () => {
  const page = read(
    "app/admin/listing-readiness/page.tsx"
  );

  assert.ok(
    page.includes(
      '"/api/admin/listing-readiness"'
    )
  );
  assert.ok(
    page.includes("report.checks.map")
  );
  assert.ok(
    page.includes("Open checklist")
  );
  assert.ok(
    page.includes("Approve pilot listing")
  );
  assert.ok(
    page.includes("Request changes")
  );
});

test("admin approval stays blocked while non-review requirements are missing", () => {
  const page = read(
    "app/admin/listing-readiness/page.tsx"
  );

  assert.ok(
    page.includes(
      'check.key !== "pilotReview"'
    )
  );
  assert.ok(
    page.includes(
      "blockersOtherThanReview.length === 0"
    )
  );
  assert.ok(
    page.includes("disabled={!canApprove}")
  );
});

test("pilot-review decisions require secure admin authorization and an audit note", () => {
  const route = read(
    "app/api/admin/listing-readiness/route.ts"
  );

  assert.ok(
    route.includes(
      "await requireSecureAdmin()"
    )
  );
  assert.ok(
    route.includes(
      "Review notes must be at least 8 characters"
    )
  );
  assert.ok(
    route.includes(
      "reviewPilotListing"
    )
  );
});

test("existing compliance administration links to final pilot review", () => {
  const page = read(
    "app/admin/property-compliance/page.tsx"
  );

  assert.ok(
    page.includes(
      'href="/admin/listing-readiness"'
    )
  );
});