import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const read = (path: string) =>
  fs.readFileSync(path, "utf8");

const readinessService = read(
  "lib/hosts/listingReadiness.ts"
);
const complianceService = read(
  "lib/compliance/propertyCompliance.ts"
);
const propertyService = read(
  "lib/hosts/hostProperties.ts"
);
const migration = read(
  "migrations/028_listing_readiness.sql"
);
const onboardingService = read(
  "lib/hosts/onboarding.ts"
);
const onboardingRoute = read(
  "app/api/hosts/onboarding/connect-account/route.ts"
);
const onboardingPage = read(
  "app/host/onboarding/connect-account/page.tsx"
);
const hostReadinessRoute = read(
  "app/api/host/properties/[id]/readiness/route.ts"
);
const adminReadinessRoute = read(
  "app/api/admin/listing-readiness/route.ts"
);
const hostCreateRoute = read(
  "app/api/host/properties/route.ts"
);
const hostUpdateRoute = read(
  "app/api/host/properties/[id]/route.ts"
);
const manifestGenerator = read(
  "scripts/generateMigrationManifest.ts"
);
const manifest = JSON.parse(
  read("scripts/migrationSchemaManifest.json")
);

test(
  "publication uses the consolidated listing-readiness gate",
  () => {
    assert.match(
      complianceService,
      /assertListingReady/
    );
    assert.match(
      propertyService,
      /assertPropertyCanPublish\(propertyId\)/
    );
    assert.match(
      hostCreateRoute,
      /LISTING_NOT_READY/
    );
    assert.match(
      hostUpdateRoute,
      /LISTING_NOT_READY/
    );
    assert.doesNotMatch(
      hostCreateRoute,
      /COMPLIANCE_APPROVAL_REQUIRED/
    );
    assert.doesNotMatch(
      hostUpdateRoute,
      /COMPLIANCE_APPROVAL_REQUIRED/
    );
  }
);

test(
  "readiness checks every required pilot listing area",
  () => {
    for (const key of [
      "basicDetails",
      "guestCapacity",
      "pricing",
      "stayPolicy",
      "privateLocation",
      "images",
      "hostAgreement",
      "payoutAccount",
      "compliance",
      "pilotReview",
    ]) {
      assert.match(
        readinessService,
        new RegExp(`key: "${key}"`)
      );
    }
  }
);

test(
  "readiness requires three images and exactly one cover",
  () => {
    assert.match(
      readinessService,
      /MINIMUM_LISTING_IMAGE_COUNT = 3/
    );
    assert.match(
      readinessService,
      /Number\(row\.cover_count\) === 1/
    );
  }
);

test(
  "host and default policy acceptance are recorded server-side",
  () => {
    assert.match(
      onboardingRoute,
      /recordHostAgreementAcceptance/
    );
    assert.match(
      onboardingService,
      /host_agreement_accepted_at = NOW\(\)/
    );
    assert.match(
      onboardingService,
      /default_policies_accepted_at = NOW\(\)/
    );
    assert.match(
      onboardingService,
      /HOST_AGREEMENT_VERSION/
    );
  }
);

test(
  "onboarding page requires two explicit consent controls",
  () => {
    assert.match(
      onboardingPage,
      /hostAgreementAccepted/
    );
    assert.match(
      onboardingPage,
      /defaultPoliciesAccepted/
    );
    assert.match(
      onboardingPage,
      /type="checkbox"/
    );
    assert.match(
      onboardingPage,
      /href="\/terms"/
    );
  }
);

test(
  "host readiness endpoint enforces property ownership",
  () => {
    assert.match(
      hostReadinessRoute,
      /requireSession\(\)/
    );
    assert.match(
      hostReadinessRoute,
      /resolveHostPropertyAccess/
    );
    assert.match(
      hostReadinessRoute,
      /getListingReadiness/
    );
  }
);

test(
  "pilot review requires secure admin authorization",
  () => {
    assert.match(
      adminReadinessRoute,
      /requireSecureAdmin\(\)/
    );
    assert.match(
      adminReadinessRoute,
      /reviewPilotListing/
    );
    assert.match(
      readinessService,
      /check\.key !== "pilotReview"/
    );
  }
);

test(
  "approved listing content changes invalidate review and publication",
  () => {
    assert.match(
      migration,
      /invalidate_property_pilot_review/
    );
    assert.match(
      migration,
      /NEW\.pilot_review_status := 'pending'/
    );
    assert.match(
      migration,
      /NEW\.status := 'draft'/
    );
    assert.match(
      migration,
      /BEFORE UPDATE OF/
    );
  }
);

test(
  "image mutations invalidate an approved pilot review",
  () => {
    assert.match(
      migration,
      /invalidate_property_image_pilot_review/
    );
    assert.match(
      migration,
      /AFTER INSERT OR UPDATE OR DELETE/
    );
    assert.match(
      migration,
      /property_images_invalidate_pilot_review/
    );
  }
);

test(
  "listing-readiness migration and manifest are registered",
  () => {
    assert.match(
      manifestGenerator,
      /028_listing_readiness\.sql/
    );

    const entry =
      manifest["028_listing_readiness.sql"];

    assert.ok(entry);
    assert.ok(entry.tables.host_profiles);
    assert.ok(entry.tables.properties);
    assert.ok(
      entry.constraints
        .properties_pilot_review_status_check
    );
    assert.ok(
      entry.functions
        .invalidate_property_pilot_review
    );
    assert.ok(
      entry.functions
        .invalidate_property_image_pilot_review
    );
    assert.ok(
      entry.triggers[
        "properties_invalidate_pilot_review@properties"
      ]
    );
    assert.ok(
      entry.triggers[
        "property_images_invalidate_pilot_review@property_images"
      ]
    );
  }
);

test(
  "already-published listings can be edited without re-entering publication",
  () => {
    assert.match(
      propertyService,
      /SELECT status FROM properties WHERE id = \$1/
    );
    assert.match(
      propertyService,
      /currentStatus\.rows\[0\]\?\.status !==[\s\S]*"published"/
    );
    assert.match(
      propertyService,
      /assertPropertyCanPublish\(propertyId\)/
    );
  }
);
