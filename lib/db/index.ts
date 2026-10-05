import { Pool, types } from "pg";
import { assertSafeTestDatabase } from "./testDatabaseGuard";

assertSafeTestDatabase();

// A PostgreSQL DATE is a calendar day, not a timestamp. The default pg
// parser creates local midnight; serializing that during BST changes the
// day to the previous UTC date. Preserve the database's literal date for
// bookings, availability and compliance, including repeated form saves.
// Timestamp parsers stay unchanged for holds, audit events and payments.
types.setTypeParser(types.builtins.DATE, (value: string) => value);

const globalForDb = globalThis as unknown as { pool?: Pool };

export const db =
  globalForDb.pool ??
  new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 20,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
  });

if (process.env.NODE_ENV !== "production") {
  globalForDb.pool = db;
}

/** Runs `fn` inside a single client checked out from the pool, so callers
 *  can BEGIN/COMMIT/ROLLBACK across multiple statements — required for
 *  the double-booking transaction in createBooking.ts, which must hold
 *  row locks across a SELECT ... FOR UPDATE and the subsequent INSERT. */
export async function withTransaction<T>(fn: (client: import("pg").PoolClient) => Promise<T>): Promise<T> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
