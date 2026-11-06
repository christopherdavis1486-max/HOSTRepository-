import { Pool } from "pg";
import { db } from "./index";
import { sessionConnectionUrl } from "./sessionConnection";

let directPool: Pool | undefined;
let configuredUrl: string | undefined;

/** Session advisory locks require a connection outside transaction pooling. */
export function sessionLockPool(): Pool {
  const connectionString = sessionConnectionUrl({
    DATABASE_URL: process.env.DATABASE_URL,
    DATABASE_URL_UNPOOLED: process.env.DATABASE_URL_UNPOOLED,
  });

  // Local tests retain their existing pool and its existing shutdown lifecycle.
  if (connectionString === process.env.DATABASE_URL) return db;

  if (directPool) {
    if (configuredUrl !== connectionString) {
      throw new Error("Session-lock database configuration changed; restart the process.");
    }
    return directPool;
  }

  directPool = new Pool({
    connectionString,
    max: 2,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
    allowExitOnIdle: true,
  });
  configuredUrl = connectionString;
  return directPool;
}
