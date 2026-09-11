import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";

import {
  createPropertySchema,
  updatePropertySchema,
} from "../validation/schemas";

const validProperty = {
  name: "Location Test Apartment",
  city: "Liverpool",
  countryCode: "GB",
  maxGuests: 2,
  bedrooms: 1,
  bathrooms: 1,
  nightlyPrice: 100,
};

test(
  "valid private address and coordinate pair are accepted",
  () => {
    const result =
      createPropertySchema.safeParse({
        ...validProperty,
        addressLine1: "1 Test Street",
        addressLine2: "Apartment 2",
        postalTown: "Liverpool",
        county: "Merseyside",
        postcode: "l1 1aa",
        latitude: "53.4084",
        longitude: "-2.9916",
      });

    assert.equal(result.success, true);

    if (result.success) {
      assert.equal(
        result.data.postcode,
        "L1 1AA"
      );
      assert.equal(
        result.data.latitude,
        53.4084
      );
      assert.equal(
        result.data.longitude,
        -2.9916
      );
    }
  }
);

test(
  "latitude without longitude is rejected",
  () => {
    const result =
      createPropertySchema.safeParse({
        ...validProperty,
        latitude: 53.4084,
      });

    assert.equal(result.success, false);

    if (!result.success) {
      assert.ok(
        result.error.issues.some(
          (issue) =>
            issue.path[0] ===
              "longitude" &&
            issue.message.includes(
              "provided together"
            )
        )
      );
    }
  }
);

test(
  "longitude without latitude is rejected",
  () => {
    const result =
      createPropertySchema.safeParse({
        ...validProperty,
        longitude: -2.9916,
      });

    assert.equal(result.success, false);
  }
);

test(
  "out-of-range coordinates are rejected",
  () => {
    assert.equal(
      createPropertySchema.safeParse({
        ...validProperty,
        latitude: 91,
        longitude: 0,
      }).success,
      false
    );

    assert.equal(
      createPropertySchema.safeParse({
        ...validProperty,
        latitude: 0,
        longitude: -181,
      }).success,
      false
    );
  }
);

test(
  "a null coordinate pair can clear a private point",
  () => {
    const result =
      updatePropertySchema.safeParse({
        latitude: null,
        longitude: null,
      });

    assert.equal(result.success, true);

    if (result.success) {
      assert.equal(
        result.data.latitude,
        null
      );
      assert.equal(
        result.data.longitude,
        null
      );
    }
  }
);

test(
  "a partial null coordinate pair is rejected",
  () => {
    const result =
      updatePropertySchema.safeParse({
        latitude: null,
        longitude: -2.9916,
      });

    assert.equal(result.success, false);
  }
);

test(
  "migration derives public location from private location",
  () => {
    const migration = fs.readFileSync(
      "migrations/026_property_location.sql",
      "utf8"
    );

    assert.match(
      migration,
      /BEFORE INSERT OR UPDATE OF private_location/
    );

    assert.match(
      migration,
      /ST_SnapToGrid\(NEW\.private_location,\s*0\.01\)/
    );

    assert.doesNotMatch(
      migration,
      /NEW\.private_location\s*:=\s*NEW\.public_location/
    );
  }
);

test(
  "guest property detail never maps private address fields",
  () => {
    const route = fs.readFileSync(
      "app/api/properties/[id]/route.ts",
      "utf8"
    );

    assert.doesNotMatch(
      route,
      /addressLine1\s*:/
    );

    assert.doesNotMatch(
      route,
      /addressLine2\s*:/
    );

    assert.doesNotMatch(
      route,
      /postalTown\s*:/
    );

    assert.doesNotMatch(
      route,
      /postcode\s*:/
    );

    assert.match(
      route,
      /publicLocation\s*:/
    );
  }
);

test(
  "guest property search never maps private address fields",
  () => {
    const route = fs.readFileSync(
      "app/api/properties/route.ts",
      "utf8"
    );

    assert.doesNotMatch(
      route,
      /addressLine1\s*:/
    );

    assert.doesNotMatch(
      route,
      /addressLine2\s*:/
    );

    assert.doesNotMatch(
      route,
      /postalTown\s*:/
    );

    assert.doesNotMatch(
      route,
      /postcode\s*:/
    );

    assert.match(
      route,
      /publicLocation\s*:/
    );
  }
);

test(
  "host update route checks property ownership",
  () => {
    const route = fs.readFileSync(
      "app/api/host/properties/[id]/route.ts",
      "utf8"
    );

    const ownershipCheck =
      route.indexOf(
        "resolveHostPropertyAccess(session, id)"
      );

    const updateCall =
      route.indexOf(
        "updatePropertyForHost(id, parsed.data)"
      );

    assert.ok(ownershipCheck >= 0);
    assert.ok(updateCall > ownershipCheck);
  }
);

test(
  "browser forms never submit publicLocation directly",
  () => {
    const createPage = fs.readFileSync(
      "app/host/properties/new/page.tsx",
      "utf8"
    );

    const editPage = fs.readFileSync(
      "app/host/properties/[id]/page.tsx",
      "utf8"
    );

    assert.doesNotMatch(
      createPage,
      /publicLocation\s*:/
    );

    assert.doesNotMatch(
      editPage,
      /publicLocation\s*:/
    );
  }
);

test(
  "migration manifest includes the location privacy objects",
  () => {
    const manifest = JSON.parse(
      fs.readFileSync(
        "scripts/migrationSchemaManifest.json",
        "utf8"
      )
    );

    const locationMigration =
      manifest[
        "026_property_location.sql"
      ];

    assert.ok(locationMigration);

    assert.ok(
      locationMigration.functions
        .derive_property_public_location
    );

    assert.ok(
      locationMigration.triggers[
        "properties_derive_public_location@properties"
      ]
    );

    assert.ok(
      locationMigration.indexes
        .idx_properties_public_location
    );
  }
);