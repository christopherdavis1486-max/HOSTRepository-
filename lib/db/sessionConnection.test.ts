import test from "node:test";
import assert from "node:assert/strict";
import { sessionConnectionUrl } from "./sessionConnection";

const pooled = "postgresql://fixture:secret@ep-fixture-pooler.eu-west-2.aws.neon.tech/host_staging?sslmode=require";
const direct = pooled.replace("-pooler.", ".");

test("local PostgreSQL can reuse its existing connection", () => {
  const url = "postgresql://fixture:secret@127.0.0.1/host_test";
  assert.equal(sessionConnectionUrl({ DATABASE_URL: url }), url);
});

test("remote session locking requires an explicit direct connection", () => {
  assert.throws(() => sessionConnectionUrl({ DATABASE_URL: pooled }),
    /DATABASE_URL_UNPOOLED is required/);
});

test("matching Neon direct connection is accepted", () => {
  assert.equal(sessionConnectionUrl({
    DATABASE_URL: pooled, DATABASE_URL_UNPOOLED: direct,
  }), direct);
});

test("Neon pooled connection cannot be supplied as direct", () => {
  assert.throws(() => sessionConnectionUrl({
    DATABASE_URL: pooled, DATABASE_URL_UNPOOLED: pooled,
  }), /require a direct/);
});

for (const [label, url] of [
  ["database", direct.replace("/host_staging", "/other_database")],
  ["role", direct.replace("fixture:secret@", "other:secret@")],
  ["endpoint", direct.replace("ep-fixture.", "ep-other.")],
]) {
  test("direct connection rejects a different " + label, () => {
    assert.throws(() => sessionConnectionUrl({
      DATABASE_URL: pooled, DATABASE_URL_UNPOOLED: url,
    }), /same database and role/);
  });
}

test("explicit transaction-pooling marker is rejected", () => {
  assert.throws(() => sessionConnectionUrl({
    DATABASE_URL: pooled,
    DATABASE_URL_UNPOOLED: direct + "&pool_mode=transaction",
  }), /require a direct/);
});

test("invalid configuration errors do not expose connection values", () => {
  const secret = "private-connection-value";
  assert.throws(() => sessionConnectionUrl({ DATABASE_URL: secret }),
    error => error instanceof Error &&
      !error.message.includes(secret) &&
      /valid PostgreSQL URL/.test(error.message));
});
