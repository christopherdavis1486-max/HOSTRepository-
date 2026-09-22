import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const script = fs.readFileSync(
  "scripts/cleanupGeneratedTestData.ts",
  "utf8",
);

test("generated-data cleanup defaults to rollback-only preview", () => {
  assert.match(
    script,
    /process\.argv\.includes\("--execute"\)/,
  );
  assert.match(
    script,
    /Preview passed\. Transaction rolled back; production was not changed\./,
  );
  assert.match(script, /await client\.query\("ROLLBACK"\)/);
});

test("execution requires the exact production host and confirmation", () => {
  assert.match(
    script,
    /ep-solitary-smoke-zav2shpw-pooler\.c-2\.eu-west-2\.aws\.neon\.tech/,
  );
  assert.match(
    script,
    /CONFIRM_GENERATED_TEST_CLEANUP/,
  );
  assert.match(
    script,
    /DELETE_7943_GENERATED_TEST_USERS/,
  );
  assert.match(
    script,
    /Execution blocked: unexpected database host/,
  );
  assert.match(
    script,
    /cleanup confirmation is missing or incorrect/,
  );
});

test("cleanup requires the audited generated-user population", () => {
  assert.match(
    script,
    /EXPECTED_GENERATED_USERS = 7_943/,
  );
  assert.match(
    script,
    /summary\.users !== EXPECTED_GENERATED_USERS/,
  );
});

test("cleanup checks protected-data boundaries before deletion", () => {
  assert.match(script, /admin_roles/);
  assert.match(script, /admin_security_actions/);
  assert.match(script, /audit_log/);
  assert.match(script, /preserved_bookings/);
  assert.match(
    script,
    /generated identities cross the protected data boundary/,
  );
});

test("dependent financial records are deleted before bookings", () => {
  const reversals = script.indexOf(
    'table: "host_transfer_reversals"',
  );
  const refunds = script.indexOf('table: "refunds"');
  const entitlements = script.indexOf(
    'table: "host_transfer_entitlements"',
  );
  const payments = script.indexOf('table: "payments"');
  const bookings = script.indexOf('table: "bookings"');

  assert.ok(reversals >= 0);
  assert.ok(refunds > reversals);
  assert.ok(entitlements > refunds);
  assert.ok(payments > entitlements);
  assert.ok(bookings > payments);
});

test("properties and profiles are deleted before generated users", () => {
  const properties = script.indexOf('table: "properties"');
  const hostProfiles = script.indexOf(
    'table: "host_profiles"',
  );
  const users = script.indexOf('table: "users"');

  assert.ok(properties >= 0);
  assert.ok(hostProfiles > properties);
  assert.ok(users > hostProfiles);
});

test("cleanup verifies generated rows are gone before commit", () => {
  assert.match(
    script,
    /Generated records remaining inside transaction/,
  );
  assert.match(
    script,
    /Preview failed: generated records would remain/,
  );

  const verification = script.indexOf(
    "Generated records remaining inside transaction",
  );
  const commit = script.indexOf(
    'await client.query("COMMIT")',
  );

  assert.ok(verification >= 0);
  assert.ok(commit > verification);
});
