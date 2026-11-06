import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { assertSafeTestDatabase } from "../db/testDatabaseGuard";

const require = createRequire(import.meta.url);
const ts = require("typescript");

test("local image service persists registration and management in rollback-only temporary storage", async () => {
  assertSafeTestDatabase({
    DATABASE_URL: process.env.DATABASE_URL,
    TEST_DATABASE_HOST: process.env.TEST_DATABASE_HOST,
    NODE_TEST_CONTEXT: "image-database-validation"
  });

  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 1,
    connectionTimeoutMillis: 5000,
    options: "-c statement_timeout=5000 -c lock_timeout=2000"
  });

  const client = await pool.connect();
  try {
    const identity = (await client.query(
      "SELECT current_database() AS name, host(inet_server_addr()) AS address"
    )).rows[0];
    assert.equal(identity.name, "host_test");
    assert.ok(["127.0.0.1", "::1"].includes(identity.address));

    await client.query("BEGIN");
    await client.query("SET LOCAL search_path = pg_temp, pg_catalog");

    await client.query(`
      CREATE TEMP TABLE users (id UUID PRIMARY KEY) ON COMMIT DROP;
      CREATE TEMP TABLE host_profiles (
        id UUID PRIMARY KEY, user_id UUID NOT NULL REFERENCES users(id)
      ) ON COMMIT DROP;
      CREATE TEMP TABLE properties (
        id UUID PRIMARY KEY, host_id UUID NOT NULL REFERENCES host_profiles(id)
      ) ON COMMIT DROP;
    `);

    const migration = fs.readFileSync(
      "migrations/027_property_images.sql", "utf8"
    ).replace(
      "CREATE TABLE IF NOT EXISTS property_images",
      "CREATE TEMP TABLE property_images"
    );
    assert.ok(migration.includes("CREATE TEMP TABLE property_images"));
    await client.query(migration);

    for (const table of ["users", "host_profiles", "properties", "property_images"]) {
      const result = await client.query(
        "SELECT relnamespace = pg_my_temp_schema() AS temporary " +
        "FROM pg_class WHERE oid = to_regclass($1)", [table]
      );
      assert.equal(result.rows[0]?.temporary, true, table);
    }

    const userId = randomUUID(), otherUserId = randomUUID();
    const hostId = randomUUID(), propertyId = randomUUID();
    await client.query("INSERT INTO users(id) VALUES ($1), ($2)",
      [userId, otherUserId]);
    await client.query("INSERT INTO host_profiles(id, user_id) VALUES ($1, $2)",
      [hostId, userId]);
    await client.query("INSERT INTO properties(id, host_id) VALUES ($1, $2)",
      [propertyId, hostId]);

    let transactionCalls = 0;
    const databaseAdapter = {
      db: { query: client.query.bind(client) },
      withTransaction: async (fn: (connection: typeof client) => Promise<unknown>) => {
        transactionCalls++;
        await client.query("SAVEPOINT image_service_operation");
        try {
          const result = await fn(client);
          await client.query("RELEASE SAVEPOINT image_service_operation");
          return result;
        } catch (error) {
          await client.query("ROLLBACK TO SAVEPOINT image_service_operation");
          await client.query("RELEASE SAVEPOINT image_service_operation");
          throw error;
        }
      }
    };

    const compiled = ts.transpileModule(
      fs.readFileSync("lib/hosts/propertyImages.ts", "utf8"),
      { compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2020
      }}
    ).outputText;
    const module = { exports: {} as any };
    vm.runInNewContext(compiled, {
      module, exports: module.exports,
      require(name: string) {
        assert.equal(name, "@/lib/db");
        return databaseAdapter;
      }
    });
    const api = module.exports;
    const blob = (name: string) => ({
      url: `https://fixture.public.blob.vercel-storage.com/properties/${propertyId}/${name}.webp`,
      pathname: `properties/${propertyId}/${name}.webp`,
      contentType: "image/webp",
      size: 4096
    });
    const errorCode = (code: string) => (error: any) => {
      assert.equal(error.code, code);
      return true;
    };

    const first = await api.registerUploadedPropertyImage(propertyId, userId, blob("first"));
    assert.equal(first.isCover, true);
    assert.equal(first.sortOrder, 0);

    const duplicate = await api.registerUploadedPropertyImage(propertyId, userId, blob("first"));
    assert.equal(duplicate.id, first.id);
    assert.equal((await client.query("SELECT count(*)::int AS n FROM property_images")).rows[0].n, 1);

    const second = await api.registerUploadedPropertyImage(propertyId, userId, blob("second"));
    assert.equal(second.isCover, false);
    assert.equal(second.sortOrder, 1);

    await assert.rejects(
      api.registerUploadedPropertyImage(propertyId, otherUserId, blob("denied")),
      errorCode("PROPERTY_NOT_FOUND")
    );

    const callsBeforeInvalid = transactionCalls;
    await assert.rejects(
      api.registerUploadedPropertyImage(propertyId, userId, {
        ...blob("bad"), pathname: `properties/${propertyId}-other/bad.webp`
      }), errorCode("INVALID_UPLOAD_PATH")
    );
    await assert.rejects(
      api.registerUploadedPropertyImage(propertyId, userId, {
        ...blob("bad"), url: "https://example.com/bad.webp"
      }), errorCode("INVALID_UPLOAD_URL")
    );
    assert.equal(transactionCalls, callsBeforeInvalid);

    await api.setPropertyImageCover(propertyId, second.id, userId);
    let rows = await api.listPropertyImages(propertyId, userId);
    assert.equal(rows.filter((row: any) => row.isCover).length, 1);
    assert.equal(rows.find((row: any) => row.isCover).id, second.id);

    await api.updatePropertyImageAltText(propertyId, first.id, userId, "Test room");
    rows = await api.reorderPropertyImages(propertyId, [second.id, first.id], userId);
    assert.deepEqual(Array.from(rows, (row: any) => row.id), [second.id, first.id]);
    assert.deepEqual(Array.from(rows, (row: any) => row.sortOrder), [0, 1]);
    assert.equal(rows[1].altText, "Test room");

    await assert.rejects(
      api.reorderPropertyImages(propertyId, [first.id, first.id], userId),
      errorCode("INVALID_PROPERTY_IMAGE_ORDER")
    );
    rows = await api.listPropertyImages(propertyId, userId);
    assert.deepEqual(Array.from(rows, (row: any) => row.id), [second.id, first.id]);

    const deleted = await api.deletePropertyImage(propertyId, second.id, userId);
    assert.equal(deleted.blobUrl, blob("second").url);
    rows = await api.listPropertyImages(propertyId, userId);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].id, first.id);
    assert.equal(rows[0].isCover, true);

    await api.deletePropertyImage(propertyId, first.id, userId);
    assert.equal((await api.listPropertyImages(propertyId, userId)).length, 0);
    await assert.rejects(
      api.deletePropertyImage(propertyId, first.id, userId),
      errorCode("PROPERTY_IMAGE_NOT_FOUND")
    );

    await client.query("ROLLBACK");
    assert.equal((await client.query(
      "SELECT to_regclass('pg_temp.property_images') AS table_name"
    )).rows[0].table_name, null);
  } finally {
    try { await client.query("ROLLBACK"); }
    finally {
      client.release(true);
      await pool.end();
    }
  }
});
