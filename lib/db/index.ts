import { Pool } from "pg";

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
