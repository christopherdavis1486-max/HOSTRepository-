import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = path.resolve(__dirname, "..");
const flags = [...new Set(
  [...fs.readFileSync(path.join(root, "lib/config/featureFlags.ts"), "utf8")
    .matchAll(/isEnabled\("(ENABLE_[A-Z_]+)"\)/g)]
    .map(match => match[1])
)];

function run(overrides: Record<string, string> = {}) {
  const env: NodeJS.ProcessEnv = { NODE_ENV: "test" };
  for (const key of [
    "PATH", "Path", "SystemRoot", "SYSTEMROOT", "WINDIR",
    "TEMP", "TMP", "COMSPEC", "PATHEXT"
  ]) {
    if (process.env[key] !== undefined) env[key] = process.env[key]!;
  }
  Object.assign(env, {
    DATABASE_URL: "postgresql://fixture:fixture@db.example.test/host_staging",
    DATABASE_URL_UNPOOLED: "postgresql://fixture:fixture@db.example.test/host_staging",
    BLOB_READ_WRITE_TOKEN: "fixture-blob-token-only",
    STRIPE_SECRET_KEY: "sk_test_fixture_only",
    NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: "pk_test_fixture_only",
    STRIPE_WEBHOOK_SECRET: "whsec_fixture_only",
    STRIPE_V2_WEBHOOK_SECRET: "whsec_fixture_only",
    AUTH_SECRET: "fixture-auth-secret-with-at-least-32-characters",
    CRON_SECRET: "fixture-cron-secret-with-at-least-32-characters",
    APP_URL: "https://staging.example.test",
    NEXTAUTH_URL: "https://staging.example.test",
    AUTH_WEBAUTHN_ORIGIN: "https://staging.example.test",
    UPSTASH_REDIS_REST_URL: "https://redis.example.test",
    UPSTASH_REDIS_REST_TOKEN: "fixture-redis-token-only",
    SECURITY_REQUIRE_DISTRIBUTED_RATE_LIMIT: "true",
    HOST_TAX_TREATMENT: "unconfigured",
    REQUIRE_EMAIL_VERIFICATION: "false",
    NEXT_PUBLIC_SHOW_STAGING_UI: "true"
  });
  for (const flag of flags) env[flag] = "false";
  Object.assign(env, overrides);
  const result = spawnSync(process.execPath,
    ["--import", "tsx", "scripts/verifyStagingConfig.ts"],
    { cwd: root, env, encoding: "utf8", timeout: 30000 });
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  return result;
}

test("staging preflight accepts disabled financial gates", () => {
  assert.ok(flags.length >= 12, "Financial gate discovery failed.");
  const result = run();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  for (const flag of flags) {
    assert.ok(result.stdout.includes("[OK] " + flag + ":"),
      "Gate was not checked: " + flag);
  }
  assert.ok(!result.stdout.includes("fixture-auth-secret"),
    "Secret value leaked in output.");
});

for (const flag of flags) {
  test("staging preflight rejects enabled gate: " + flag, () => {
    const result = run({ [flag]: "true" });
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.ok(result.stdout.includes("[ERROR] " + flag + ":"),
      "Enabled gate did not produce its own error.");
  });
}

for (const token of ["", "..."]) {
  test("staging preflight rejects missing or placeholder Blob token: " +
    JSON.stringify(token), () => {
    const result = run({ BLOB_READ_WRITE_TOKEN: token });
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.ok(result.stdout.includes("[ERROR] BLOB_READ_WRITE_TOKEN:"));
  });
}

test("staging preflight does not print the Blob token", () => {
  const token = "fixture-private-blob-value-for-output-check";
  const result = run({ BLOB_READ_WRITE_TOKEN: token });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.ok(!result.stdout.includes(token));
  assert.ok(!result.stderr.includes(token));
});


for (const [label, direct] of [
  ["missing", ""],
  ["placeholder", "..."],
  ["different database", "postgresql://fixture:fixture@db.example.test/other"],
  ["different role", "postgresql://other:fixture@db.example.test/host_staging"],
  ["different endpoint", "postgresql://fixture:fixture@other.example.test/host_staging"],
  ["transaction pooling", "postgresql://fixture:fixture@db.example.test/host_staging?pool_mode=transaction"],
]) {
  test("staging preflight rejects direct connection: " + label, () => {
    const result = run({ DATABASE_URL_UNPOOLED: direct });
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.ok(result.stdout.includes("[ERROR] DATABASE_URL_UNPOOLED:"));
  });
}

test("staging preflight accepts matching Neon pooled and direct configuration", () => {
  const primary = "postgresql://fixture:private-fixture@ep-fixture-pooler.eu-west-2.aws.neon.tech/host_staging?sslmode=require";
  const direct = primary.replace("-pooler.", ".");
  const result = run({
    DATABASE_URL: primary,
    DATABASE_URL_UNPOOLED: direct,
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const output = result.stdout + result.stderr;
  assert.ok(!output.includes(primary));
  assert.ok(!output.includes(direct));
  assert.ok(!output.includes("private-fixture"));
});

test("staging preflight rejects a Neon pooler supplied as direct", () => {
  const pooled = "postgresql://fixture:fixture@ep-fixture-pooler.eu-west-2.aws.neon.tech/host_staging?sslmode=require";
  const result = run({
    DATABASE_URL: pooled,
    DATABASE_URL_UNPOOLED: pooled,
  });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.ok(result.stdout.includes("[ERROR] DATABASE_URL_UNPOOLED:"));
});

const savedCardEnv: Record<string, string> = {
  HOST_STAGING_ACCEPTANCE_MODE: "saved_card",
  VERCEL_ENV: "preview",
  VERCEL_GIT_COMMIT_REF: "host-staging-preview",
  APP_URL: "https://host-git-host-staging-preview-host-team1.vercel.app",
  NEXTAUTH_URL: "https://host-git-host-staging-preview-host-team1.vercel.app",
  AUTH_WEBAUTHN_ORIGIN: "https://host-git-host-staging-preview-host-team1.vercel.app",
  ENABLE_DELAYED_CHARGE_BOOKINGS: "true",
  ENABLE_STAGING_UNPAID_INTENT_CLEANUP: "false",
};

test("saved-card acceptance permits booking creation with execution disabled", () => {
  const result = run(savedCardEnv);
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

for (const flag of flags.filter(flag => flag !== "ENABLE_DELAYED_CHARGE_BOOKINGS")) {
  for (const setting of ["true", "", " false "]) {
    test("saved-card acceptance rejects gate " + flag + "=" + JSON.stringify(setting), () => {
      const result = run({ ...savedCardEnv, [flag]: setting });
      assert.equal(result.status, 1, result.stdout + result.stderr);
      assert.ok(result.stdout.includes("[ERROR] " + flag + ":"));
    });
  }
}

const invalidContexts: Record<string, string>[] = [
  { VERCEL_ENV: "production" },
  { VERCEL_ENV: "" },
  { VERCEL_GIT_COMMIT_REF: "main" },
  { APP_URL: "https://other.example.test" },
  { NEXTAUTH_URL: "https://other.example.test" },
  { AUTH_WEBAUTHN_ORIGIN: "https://other.example.test" },
  { ENABLE_DELAYED_CHARGE_BOOKINGS: "false" },
  { ENABLE_STAGING_UNPAID_INTENT_CLEANUP: "true" },
  { ENABLE_STAGING_UNPAID_INTENT_CLEANUP: "" },
  { HOST_STAGING_ACCEPTANCE_MODE: "saved_card " },
];

for (const overrides of invalidContexts) {
  test("saved-card acceptance rejects invalid context " + JSON.stringify(overrides), () => {
    const result = run({ ...savedCardEnv, ...overrides });
    assert.equal(result.status, 1, result.stdout + result.stderr);
  });
}
