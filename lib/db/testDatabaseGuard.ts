type TestEnvironment = {
  DATABASE_URL?: string;
  TEST_DATABASE_HOST?: string;
  NODE_TEST_CONTEXT?: string;
};

const LOOPBACK_TEST_HOSTS = new Set([
  "127.0.0.1",
  "localhost",
  "::1",
  "[::1]",
]);

const REQUIRED_TEST_DATABASE_NAME = "host_test";

/**
 * Node's test runner sets NODE_TEST_CONTEXT in test workers.
 * Database-backed tests must use the dedicated local host_test
 * database. TEST_DATABASE_HOST remains an explicit confirmation,
 * but cannot authorize a remote host or non-test database.
 */
export function assertSafeTestDatabase(
  environment: TestEnvironment = {
    DATABASE_URL: process.env.DATABASE_URL,
    TEST_DATABASE_HOST: process.env.TEST_DATABASE_HOST,
    NODE_TEST_CONTEXT: process.env.NODE_TEST_CONTEXT,
  },
): void {
  if (!environment.NODE_TEST_CONTEXT) return;

  const expectedHost =
    environment.TEST_DATABASE_HOST?.trim().toLowerCase();

  if (!expectedHost) {
    throw new Error(
      "Database tests are blocked: TEST_DATABASE_HOST is not configured.",
    );
  }

  const databaseUrl = environment.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error(
      "Database tests are blocked: DATABASE_URL is not configured.",
    );
  }

  let parsedDatabaseUrl: URL;
  try {
    parsedDatabaseUrl = new URL(databaseUrl);
  } catch {
    throw new Error(
      "Database tests are blocked: DATABASE_URL is not a valid URL.",
    );
  }

  const actualHost =
    parsedDatabaseUrl.hostname.toLowerCase();
  const databaseName =
    decodeURIComponent(parsedDatabaseUrl.pathname.slice(1));

  if (!LOOPBACK_TEST_HOSTS.has(actualHost)) {
    throw new Error(
      `Database tests are blocked: DATABASE_URL host "${actualHost}" is not a local loopback host.`,
    );
  }

  if (!LOOPBACK_TEST_HOSTS.has(expectedHost)) {
    throw new Error(
      `Database tests are blocked: TEST_DATABASE_HOST "${expectedHost}" is not a local loopback host.`,
    );
  }

  if (actualHost !== expectedHost) {
    throw new Error(
      `Database tests are blocked: DATABASE_URL host "${actualHost}" does not match permitted TEST_DATABASE_HOST "${expectedHost}".`,
    );
  }

  if (databaseName !== REQUIRED_TEST_DATABASE_NAME) {
    throw new Error(
      `Database tests are blocked: database "${databaseName}" is not the required "${REQUIRED_TEST_DATABASE_NAME}" test database.`,
    );
  }
}
