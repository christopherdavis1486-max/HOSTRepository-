import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

function read(relativePath: string): string {
  return fs.readFileSync(
    path.join(process.cwd(), relativePath),
    "utf8",
  );
}

test("guest property pages render only the safe public location", () => {
  const page = read("app/stays/[slug]/page.tsx");
  const component = read(
    "components/PropertyLocationMap.tsx",
  );
  const sharedMap = read("components/PropertyMap.tsx");

  assert.ok(page.includes(
    "publicLocation: { type: \"Point\"",
  ));
  assert.ok(page.includes(
    "location={property.publicLocation}",
  ));
  assert.equal(
    page.includes("private_location"),
    false,
  );
  assert.ok(component.includes(
    "position: [latitude, longitude]",
  ));
  assert.ok(sharedMap.includes(
    "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
  ));
});

test("all property maps use monochrome tiles and gold markers", () => {
  const sharedMap = read("components/PropertyMap.tsx");

  assert.match(
    sharedMap,
    /filter:\s*grayscale\(1\)/,
  );
  assert.ok(sharedMap.includes(
    "tilePane.style.filter",
  ));
  assert.ok(sharedMap.includes(
    "background: #c9974b",
  ));
  assert.ok(sharedMap.includes(
    'className: "host-map-marker"',
  ));
});

test("map tiles are restricted by content security policy", () => {
  const middleware = read("middleware.ts");

  assert.match(
    middleware,
    /img-src[^"]*https:\/\/\*\.tile\.openstreetmap\.org/,
  );
  assert.doesNotMatch(
    middleware,
    /frame-src[^"]*openstreetmap/,
  );
});

test("the homepage maps published properties without private coordinates", () => {
  const page = read("app/page.tsx");
  const component = read(
    "components/HomepagePropertyMap.tsx",
  );

  assert.ok(page.includes(
    'import { HomepagePropertyMap }',
  ));
  assert.ok(page.includes("<HomepagePropertyMap"));
  assert.ok(component.includes(
    'fetch("/api/properties"',
  ));
  assert.ok(component.includes(
    "property.publicLocation",
  ));
  assert.ok(component.includes(
    "position: [latitude, longitude]",
  ));
  assert.doesNotMatch(
    component,
    /private_location|privateLocation/,
  );
});

test("homepage map wording exists in every interface language", () => {
  const messages = read("lib/i18n/messages.ts");

  for (const key of [
    "mapEyebrow",
    "mapHeading",
    "mapPrivacy",
    "mapLoading",
  ]) {
    assert.equal(
      messages.match(new RegExp(`${key}:`, "g"))?.length,
      6,
    );
  }
});

test("map privacy wording exists in every guest language", () => {
  const messages = read("lib/i18n/guestMessages.ts");

  assert.equal(
    messages.match(/approximateLocation:/g)?.length,
    6,
  );
  assert.equal(
    messages.match(/locationPrivacy:/g)?.length,
    6,
  );
});

test("guest reviews remain visible after the location map", () => {
  const page = read("app/stays/[slug]/page.tsx");

  const mapPosition = page.indexOf(
    "<PropertyLocationMap",
  );
  const reviewsPosition = page.indexOf(
    "<PropertyReviews",
  );

  assert.ok(mapPosition >= 0);
  assert.ok(reviewsPosition > mapPosition);
});


test("public reviews require both the review and property to be published", () => {
  const service = read("lib/reviews/createReview.ts");

  assert.match(
    service,
    /JOIN properties p ON p\.id = r\.property_id/,
  );
  assert.match(
    service,
    /r\.status = 'published'/,
  );
  assert.match(
    service,
    /p\.status = 'published'/,
  );
  const publicListingFunction = service.slice(
    service.indexOf(
      "export async function listPropertyReviews",
    ),
  );

  assert.doesNotMatch(
    publicListingFunction,
    /guest_id/,
  );
});
