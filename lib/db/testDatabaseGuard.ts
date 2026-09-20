type TestEnvironment = {
  DATABASE_URL?: string;
  TEST_DATABASE_HOST?: string;
  NODE_TEST_CONTEXT?: string;
};

/**
 * Node's test runner sets NODE_TEST_CONTEXT in test workers.
 * Any database-backed test must explicitly name its permitted database host.
 * This prevents an accidentally supplied production URL from being used.
 */
export function assertSafeTestDatabase(
  environment: TestEnvironment = {
    DATABASE_URL: process.env.DATABASE_URL,
    TEST_DATABASE_HOST: process.env.TEST_DATABASE_HOST,
    NODE_TEST_CONTEXT: process.env.NODE_TEST_CONTEXT,
  },
): void {
  if (!environment.NODE_TEST_CONTEXT) return;

  const expectedHost = environment.TEST_DATABASE_HOST?.trim().toLowerCase();
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

  let actualHost: string;
  try {
    actualHost = new URL(databaseUrl).hostname.toLowerCase();
  } catch {
    throw new Error(
      "Database tests are blocked: DATABASE_URL is not a valid URL.",
    );
  }

  if (actualHost !== expectedHost) {
    throw new Error(
      `Database tests are blocked: DATABASE_URL host "${actualHost}" does not match permitted TEST_DATABASE_HOST "${expectedHost}".`,
    );
  }
}
