import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { sessionConnectionUrl } from "./sessionConnection";

function harness(env: Record<string, string>) {
  const constructed: any[] = [];
  const ordinaryPool = { fixture: "ordinary" };

  class FakePool {
    constructor(options: any) { constructed.push(options); }
  }

  const exports: Record<string, any> = {};
  const compiled = ts.transpileModule(
    fs.readFileSync("lib/db/sessionPool.ts", "utf8"),
    { compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
    } },
  ).outputText;

  vm.runInNewContext(compiled, {
    exports,
    process: { env },
    require(name: string) {
      if (name === "pg") return { Pool: FakePool };
      if (name === "./index") return { db: ordinaryPool };
      if (name === "./sessionConnection") return { sessionConnectionUrl };
      throw new Error("Unexpected dependency: " + name);
    },
  });

  return { get: exports.sessionLockPool, constructed, ordinaryPool };
}

const pooled = "postgresql://fixture:secret@ep-fixture-pooler.eu-west-2.aws.neon.tech/host_staging?sslmode=require";
const direct = pooled.replace("-pooler.", ".");

test("local session locking reuses the ordinary pool", () => {
  const fixture = harness({
    DATABASE_URL: "postgresql://fixture:secret@127.0.0.1/host_test",
  });
  assert.equal(fixture.get(), fixture.ordinaryPool);
  assert.equal(fixture.constructed.length, 0);
});

test("missing remote direct configuration creates no pool", () => {
  const fixture = harness({ DATABASE_URL: pooled });
  assert.throws(() => fixture.get(), /DATABASE_URL_UNPOOLED/);
  assert.equal(fixture.constructed.length, 0);
});

test("remote session locking constructs and reuses a dedicated direct pool", () => {
  const fixture = harness({
    DATABASE_URL: pooled,
    DATABASE_URL_UNPOOLED: direct,
  });
  const first = fixture.get();
  assert.notEqual(first, fixture.ordinaryPool);
  assert.equal(fixture.get(), first);
  assert.equal(fixture.constructed.length, 1);
  assert.equal(fixture.constructed[0].connectionString, direct);
  assert.equal(fixture.constructed[0].max, 2);
  assert.equal(fixture.constructed[0].connectionTimeoutMillis, 5000);
});

test("a pooled URL supplied as direct creates no pool", () => {
  const fixture = harness({
    DATABASE_URL: pooled,
    DATABASE_URL_UNPOOLED: pooled,
  });
  assert.throws(() => fixture.get(), /direct database connection/);
  assert.equal(fixture.constructed.length, 0);
});

test("a mismatched direct database creates no pool", () => {
  const fixture = harness({
    DATABASE_URL: pooled,
    DATABASE_URL_UNPOOLED: direct.replace("/host_staging", "/other"),
  });
  assert.throws(() => fixture.get(), /same database and role/);
  assert.equal(fixture.constructed.length, 0);
});

test("changing direct credentials requires a process restart", () => {
  const env = { DATABASE_URL: pooled, DATABASE_URL_UNPOOLED: direct };
  const fixture = harness(env);
  fixture.get();
  env.DATABASE_URL_UNPOOLED = direct.replace(":secret@", ":changed@");
  assert.throws(() => fixture.get(), /restart the process/);
  assert.equal(fixture.constructed.length, 1);
});
