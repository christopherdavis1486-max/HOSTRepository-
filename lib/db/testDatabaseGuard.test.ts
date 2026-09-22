import test from "node:test";
import assert from "node:assert/strict";
import { assertSafeTestDatabase } from "./testDatabaseGuard";

test("does nothing outside the Node test runner", () => {
  assert.doesNotThrow(() =>
    assertSafeTestDatabase({
      DATABASE_URL:
        "postgresql://user:password@production.example/db",
    }),
  );
});

test("blocks database tests when TEST_DATABASE_HOST is missing", () => {
  assert.throws(
    () =>
      assertSafeTestDatabase({
        NODE_TEST_CONTEXT: "child-v8",
        DATABASE_URL:
          "postgresql://user:password@127.0.0.1:5432/host_test",
      }),
    /TEST_DATABASE_HOST is not configured/,
  );
});

test("blocks a remote host even when explicitly permitted", () => {
  assert.throws(
    () =>
      assertSafeTestDatabase({
        NODE_TEST_CONTEXT: "child-v8",
        DATABASE_URL:
          "postgresql://user:password@example.neon.tech/neondb",
        TEST_DATABASE_HOST: "example.neon.tech",
      }),
    /is not a local loopback host/,
  );
});

test("blocks a non-test database on localhost", () => {
  assert.throws(
    () =>
      assertSafeTestDatabase({
        NODE_TEST_CONTEXT: "child-v8",
        DATABASE_URL:
          "postgresql://user:password@127.0.0.1:5432/host",
        TEST_DATABASE_HOST: "127.0.0.1",
      }),
    /is not the required "host_test" test database/,
  );
});

test("blocks a local host that does not match the permitted host", () => {
  assert.throws(
    () =>
      assertSafeTestDatabase({
        NODE_TEST_CONTEXT: "child-v8",
        DATABASE_URL:
          "postgresql://user:password@127.0.0.1:5432/host_test",
        TEST_DATABASE_HOST: "localhost",
      }),
    /does not match permitted TEST_DATABASE_HOST/,
  );
});

test("allows the dedicated local test database", () => {
  assert.doesNotThrow(() =>
    assertSafeTestDatabase({
      NODE_TEST_CONTEXT: "child-v8",
      DATABASE_URL:
        "postgresql://user:password@127.0.0.1:5432/host_test",
      TEST_DATABASE_HOST: "127.0.0.1",
    }),
  );
});

test("blocks a malformed database URL", () => {
  assert.throws(
    () =>
      assertSafeTestDatabase({
        NODE_TEST_CONTEXT: "child-v8",
        DATABASE_URL: "not-a-database-url",
        TEST_DATABASE_HOST: "127.0.0.1",
      }),
    /DATABASE_URL is not a valid URL/,
  );
});

test("blocks database tests when DATABASE_URL is missing", () => {
  assert.throws(
    () =>
      assertSafeTestDatabase({
        NODE_TEST_CONTEXT: "child-v8",
        TEST_DATABASE_HOST: "127.0.0.1",
      }),
    /DATABASE_URL is not configured/,
  );
});
