type SessionConnectionEnvironment = {
  DATABASE_URL?: string;
  DATABASE_URL_UNPOOLED?: string;
};

function parse(value: string | undefined): URL {
  try {
    const url = new URL(value ?? "");
    if (!["postgres:", "postgresql:"].includes(url.protocol)) throw new Error();
    return url;
  } catch {
    throw new Error("Session-lock database configuration requires a valid PostgreSQL URL.");
  }
}

function isNeonPooler(url: URL): boolean {
  return url.hostname.endsWith(".neon.tech") &&
    url.hostname.includes("-pooler.");
}

function directHost(url: URL): string {
  return isNeonPooler(url)
    ? url.hostname.replace("-pooler.", ".")
    : url.hostname;
}

export function sessionConnectionUrl(env: SessionConnectionEnvironment): string {
  const primary = parse(env.DATABASE_URL);
  const loopback = ["localhost", "127.0.0.1", "::1", "[::1]"].includes(primary.hostname);

  if (!env.DATABASE_URL_UNPOOLED) {
    if (loopback) return env.DATABASE_URL!;
    throw new Error("DATABASE_URL_UNPOOLED is required for remote session-lock operations.");
  }

  const direct = parse(env.DATABASE_URL_UNPOOLED);
  if (isNeonPooler(direct) ||
      direct.searchParams.get("pgbouncer") === "true" ||
      direct.searchParams.get("pool_mode") === "transaction") {
    throw new Error("Session-lock operations require a direct database connection.");
  }

  if (directHost(primary) !== direct.hostname ||
      (primary.port || "5432") !== (direct.port || "5432") ||
      decodeURIComponent(primary.pathname) !== decodeURIComponent(direct.pathname) ||
      decodeURIComponent(primary.username) !== decodeURIComponent(direct.username)) {
    throw new Error("Direct session-lock connection must target the same database and role.");
  }

  return env.DATABASE_URL_UNPOOLED!;
}
