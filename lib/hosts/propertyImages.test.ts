import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const read = (path: string) =>
  fs.readFileSync(path, "utf8");

const migration = read(
  "migrations/027_property_images.sql"
);
const service = read(
  "lib/hosts/propertyImages.ts"
);
const uploadRoute = read(
  "app/api/host/properties/[id]/images/upload/route.ts"
);
const managementRoute = read(
  "app/api/host/properties/[id]/images/route.ts"
);
const deletionRoute = read(
  "app/api/host/properties/[id]/images/[imageId]/route.ts"
);
const publicDetailRoute = read(
  "app/api/properties/[id]/route.ts"
);
const publicSearchRoute = read(
  "app/api/properties/route.ts"
);
const managerComponent = read(
  "components/PropertyImageManager.tsx"
);
const galleryComponent = read(
  "components/PropertyGallery.tsx"
);
const stayPage = read(
  "app/stays/[slug]/page.tsx"
);
const searchPage = read(
  "app/search/page.tsx"
);
const manifestGenerator = read(
  "scripts/generateMigrationManifest.ts"
);
const manifest = JSON.parse(
  read("scripts/migrationSchemaManifest.json")
);

test(
  "property image migration enforces ownership linkage and deletion",
  () => {
    assert.match(
      migration,
      /CREATE TABLE IF NOT EXISTS property_images/
    );
    assert.match(
      migration,
      /REFERENCES properties\(id\)[\s\S]*ON DELETE CASCADE/
    );
    assert.match(
      migration,
      /REFERENCES users\(id\)[\s\S]*ON DELETE SET NULL/
    );
  }
);

test(
  "property image migration restricts type size and ordering",
  () => {
    assert.match(migration, /image\/jpeg/);
    assert.match(migration, /image\/png/);
    assert.match(migration, /image\/webp/);
    assert.match(
      migration,
      /size_bytes <= 10485760/
    );
    assert.match(migration, /sort_order >= 0/);
  }
);

test(
  "only one cover image can exist for each property",
  () => {
    assert.match(
      migration,
      /CREATE UNIQUE INDEX IF NOT EXISTS[\s\S]*property_images_one_cover_idx[\s\S]*ON property_images \(property_id\)[\s\S]*WHERE is_cover = TRUE/
    );
  }
);

test(
  "image service always verifies property ownership",
  () => {
    assert.match(
      service,
      /JOIN host_profiles hp ON hp\.id = p\.host_id/
    );
    assert.match(
      service,
      /hp\.user_id = \$2/
    );
    assert.match(
      service,
      /FOR UPDATE OF p/
    );
  }
);

test(
  "image upload limit is serialized without locking an aggregate",
  () => {
    assert.match(
      service,
      /MAX_PROPERTY_IMAGES = 30/
    );
    assert.doesNotMatch(
      service,
      /COUNT\(\*\)[\s\S]{0,160}FOR UPDATE/
    );
    assert.match(
      service,
      /FOR UPDATE OF p/
    );
  }
);

test(
  "upload route requires authentication and property access",
  () => {
    assert.match(uploadRoute, /requireSession\(\)/);
    assert.match(
      uploadRoute,
      /resolveHostPropertyAccess\(session, propertyId\)/
    );
    assert.match(
      uploadRoute,
      /allowedContentTypes/
    );
    assert.match(
      uploadRoute,
      /maximumSizeInBytes:\s*10 \* 1024 \* 1024/
    );
    assert.match(
      uploadRoute,
      /properties\/\$\{propertyId\}/
    );
  }
);

test(
  "image management and deletion routes enforce ownership",
  () => {
    assert.match(
      managementRoute,
      /resolveHostPropertyAccess\(session, propertyId\)/
    );
    assert.match(
      deletionRoute,
      /resolveHostPropertyAccess\(session, propertyId\)/
    );
    assert.match(
      deletionRoute,
      /deletePropertyImage/
    );
    assert.match(deletionRoute, /await del\(blobUrl\)/);
  }
);

test(
  "host image manager supports upload cover order alt text and deletion",
  () => {
    assert.match(
      managerComponent,
      /@vercel\/blob\/client/
    );
    assert.match(
      managerComponent,
      /action:\s*"setCover"/
    );
    assert.match(
      managerComponent,
      /action:\s*"reorder"/
    );
    assert.match(
      managerComponent,
      /action:\s*"updateAltText"/
    );
    assert.match(
      managerComponent,
      /method:\s*"DELETE"/
    );
  }
);

test(
  "public APIs expose display URLs but not storage pathnames",
  () => {
    assert.match(
      publicDetailRoute,
      /'url', pi\.blob_url/
    );
    assert.match(
      publicSearchRoute,
      /'url', pi\.blob_url/
    );
    assert.doesNotMatch(
      publicDetailRoute,
      /'pathname', pi\.blob_pathname/
    );
    assert.doesNotMatch(
      publicSearchRoute,
      /'pathname', pi\.blob_pathname/
    );
  }
);

test(
  "guest pages render real property images",
  () => {
    assert.match(
      galleryComponent,
      /selectedImage\.url/
    );
    assert.match(
      stayPage,
      /<PropertyGallery/
    );
    assert.match(
      searchPage,
      /property\.coverImage\.url/
    );
  }
);

test(
  "migration generator and manifest include property images",
  () => {
    assert.match(
      manifestGenerator,
      /027_property_images\.sql/
    );

    const imageManifest =
      manifest["027_property_images.sql"];

    assert.ok(imageManifest);
    assert.ok(
      imageManifest.tables.property_images
    );
    assert.ok(
      imageManifest.indexes
        .property_images_one_cover_idx
    );
    assert.ok(
      imageManifest.constraints
        .property_images_property_id_fkey
    );
    assert.ok(
      imageManifest.constraints
        .property_images_content_type_check
    );
  }
);