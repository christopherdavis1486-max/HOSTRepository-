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

test("the customer navigation offers host acquisition to non-host users", () => {
  const source = read("components/CustomerNav.tsx");

  assert.ok(source.includes('href="/host-with-us"'));
  assert.ok(source.includes('t("listProperty")'));
  assert.ok(source.includes("!sessionState.isHost"));
  assert.ok(source.includes('href="/host/dashboard"'));
});

test("the homepage provides host acquisition entry points", () => {
  const source = read("app/page.tsx");

  assert.ok(source.includes('href="/host-with-us"'));
  assert.ok(source.includes('t("listProperty")'));
  assert.ok(source.includes("!sessionState.isHost"));
  assert.ok(source.includes('href="/host/dashboard"'));
});

test("the public host information page uses the secure onboarding route", () => {
  const source = read("app/host-with-us/page.tsx");

  assert.ok(source.includes(
    "/login?mode=register&returnTo=%2Fhost%2Fonboarding%2Fconnect-account",
  ));

  assert.ok(source.includes(
    "/login?returnTo=%2Fhost%2Fonboarding%2Fconnect-account",
  ));

  assert.equal(
    source.includes("connect.stripe.com"),
    false,
  );
});

test("every supported language includes the list-property message", () => {
  const source = read("lib/i18n/messages.ts");

  assert.ok(source.includes('listProperty: "Become a HOST"'));
  assert.ok(source.includes('listProperty: "HOST-Gastgeber werden"'));
  assert.ok(source.includes(
    'listProperty: "Devenir hôte HOST"',
  ));
  assert.ok(source.includes(
    'listProperty: "Conviértete en anfitrión HOST"',
  ));
  assert.ok(source.includes(
    'listProperty: "Diventa host su HOST"',
  ));
  assert.ok(source.includes(
    'listProperty: "Word HOST-host"',
  ));
});

test("existing hosts retain direct access to their workspace", () => {
  const customerNav = read("components/CustomerNav.tsx");
  const homepage = read("app/page.tsx");

  assert.ok(customerNav.includes("sessionState.isHost"));
  assert.ok(customerNav.includes('href="/host/dashboard"'));

  assert.ok(homepage.includes("sessionState.isHost"));
  assert.ok(homepage.includes('href="/host/dashboard"'));
});