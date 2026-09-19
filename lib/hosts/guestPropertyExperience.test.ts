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
    "https://www.openstreetmap.org/export/embed.html",
  ));
  assert.ok(component.includes(
    'referrerPolicy="no-referrer"',
  ));
  assert.ok(component.includes(
    'loading="lazy"',
  ));
});

test("the map frame is restricted by content security policy", () => {
  const middleware = read("middleware.ts");

  assert.match(
    middleware,
    /frame-src[^"]*https:\/\/www\.openstreetmap\.org/,
  );
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
