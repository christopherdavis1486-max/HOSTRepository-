import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

function read(path: string) {
  return fs.readFileSync(path, "utf8");
}

test("first-time host onboarding uses the real route", () => {
  const account = read("app/account/page.tsx");
  assert.match(account, /href="\/host\/onboarding\/connect-account"/);
  assert.doesNotMatch(account, /href="\/hosts\/onboarding\/connect-account"/);
});

test("host onboarding refreshes roles before checking status", () => {
  const auth = read("lib/auth/authOptions.ts");
  const complete = read("app/host/onboarding/complete/page.tsx");
  assert.match(auth, /trigger === "update"/);
  assert.match(complete, /useSession/);
  assert.match(complete, /update\(\)/);
  assert.match(complete, /href="\/host\/dashboard"/);
});

test("the application provides NextAuth session context", () => {
  const layout = read("app/layout.tsx");
  assert.match(layout, /AuthSessionProvider/);
});
