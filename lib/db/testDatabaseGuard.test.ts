import test from "node:test";
import assert from "node:assert/strict";
import { assertSafeTestDatabase } from "./testDatabaseGuard";

test("does nothing outside the Node test runner", () => {
  assert.doesNotThrow(() =>
    assertSafeTestDatabase({
      DATABASE_URL: "postgresql://user:password@production.example/db",
    }),
  );
});

test("blocks database tests when TEST_DATABASE_HOST is missing", () => {
  assert.throws(
    () =>
      assertSafeTestDatabase({
        NODE_TEST_CONTEXT: "child-v8",
        DATABASE_URL: "postgresql://user:password@test.example/db",
      }),
    /TEST_DATABASE_HOST is not configured/,
  );
});

test("blocks a database URL whose host does not match the permitted test host", () => {
  assert.throws(
    () =>
      assertSafeTestDatabase({
        NODE_TEST_CONTEXT: "child-v8",
        DATABASE_URL: "postgresql://user:password@production.example/db",
        TEST_DATABASE_HOST: "test.example",
      }),
    /does not match permitted TEST_DATABASE_HOST/,
  );
});

test("allows the explicitly permitted test database host", () => {
  assert.doesNotThrow(() =>
    assertSafeTestDatabase({
      NODE_TEST_CONTEXT: "child-v8",
      DATABASE_URL: "postgresql://user:password@test.example/db",
      TEST_DATABASE_HOST: "TEST.EXAMPLE",
    }),
  );
});

test("blocks a malformed database URL", () => {
  assert.throws(
    () =>
      assertSafeTestDatabase({
        NODE_TEST_CONTEXT: "child-v8",
        DATABASE_URL: "not-a-database-url",
        TEST_DATABASE_HOST: "test.example",
      }),
    /DATABASE_URL is not a valid URL/,
  );
});

test("blocks database tests when DATABASE_URL is missing", () => {
  assert.throws(
    () =>
      assertSafeTestDatabase({
        NODE_TEST_CONTEXT: "child-v8",
        TEST_DATABASE_HOST: "test.example",
      }),
    /DATABASE_URL is not configured/,
  );
});
