type Level = "ERROR" | "WARNING" | "OK";
type Finding = { level: Level; name: string; detail: string };

const findings: Finding[] = [];
const value = (name: string) => process.env[name]?.trim() ?? "";
const add = (level: Level, name: string, detail: string) => findings.push({ level, name, detail });

function requireValue(name: string, minimumLength = 1) {
  const configured = value(name);
  if (!configured || configured.includes("...")) add("ERROR", name, "Missing or still contains a placeholder.");
  else if (configured.length < minimumLength) add("ERROR", name, `Must be at least ${minimumLength} characters.`);
  else add("OK", name, "Configured.");
  return configured;
}

function requirePrefix(name: string, prefix: string) {
  const configured = requireValue(name, prefix.length + 4);
  if (configured && !configured.includes("...") && !configured.startsWith(prefix)) {
    add("ERROR", name, `Must use the ${prefix} test-mode prefix for staging.`);
  }
}

function requireHttps(name: string) {
  const configured = requireValue(name);
  if (!configured || configured.includes("...")) return "";
  try {
    const parsed = new URL(configured);
    if (parsed.protocol !== "https:") add("ERROR", name, "Must use HTTPS in staging.");
    else add("OK", name, "Uses HTTPS.");
    return parsed.origin;
  } catch {
    add("ERROR", name, "Must be a valid absolute URL.");
    return "";
  }
}

const databaseUrl = requireValue("DATABASE_URL");
if (databaseUrl && !databaseUrl.includes("...") && !/^postgres(ql)?:\/\//.test(databaseUrl)) {
  add("ERROR", "DATABASE_URL", "Must be a PostgreSQL connection URL.");
}
if (databaseUrl && /localhost|127\.0\.0\.1/i.test(databaseUrl)) {
  add("ERROR", "DATABASE_URL", "Staging must not point to a local database.");
}

requirePrefix("STRIPE_SECRET_KEY", "sk_test_");
requirePrefix("NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY", "pk_test_");
requirePrefix("STRIPE_WEBHOOK_SECRET", "whsec_");
requirePrefix("STRIPE_V2_WEBHOOK_SECRET", "whsec_");

requireValue("AUTH_SECRET", 32);
requireValue("CRON_SECRET", 32);
const appOrigin = requireHttps("APP_URL");
const nextAuthOrigin = requireHttps("NEXTAUTH_URL");
const webAuthnOrigin = requireHttps("AUTH_WEBAUTHN_ORIGIN");
if (appOrigin && nextAuthOrigin && appOrigin !== nextAuthOrigin) add("ERROR", "NEXTAUTH_URL", "Must have the same origin as APP_URL.");
if (appOrigin && webAuthnOrigin && appOrigin !== webAuthnOrigin) add("ERROR", "AUTH_WEBAUTHN_ORIGIN", "Must have the same origin as APP_URL.");

requireHttps("UPSTASH_REDIS_REST_URL");
requireValue("UPSTASH_REDIS_REST_TOKEN", 16);
if (value("SECURITY_REQUIRE_DISTRIBUTED_RATE_LIMIT") !== "true") {
  add("ERROR", "SECURITY_REQUIRE_DISTRIBUTED_RATE_LIMIT", "Must be exactly true for staging.");
} else add("OK", "SECURITY_REQUIRE_DISTRIBUTED_RATE_LIMIT", "Fail-closed distributed limiting enabled.");

for (const flag of ["ENABLE_DELAYED_CHARGE_BOOKINGS", "ENABLE_AUTOMATED_OFFSESSION_CHARGING", "ENABLE_HOST_TRANSFER_EXECUTION"]) {
  if (value(flag) === "true") add("ERROR", flag, "Must remain false while Funds Segregation approval and hold-period design are unresolved.");
  else add("OK", flag, "Safely disabled.");
}

if (value("HOST_TAX_TREATMENT") !== "unconfigured") {
  add("WARNING", "HOST_TAX_TREATMENT", "A tax treatment is selected; confirm it has written legal/accounting approval.");
} else add("OK", "HOST_TAX_TREATMENT", "Unresolved tax decision remains fail-closed.");

if (value("REQUIRE_EMAIL_VERIFICATION") === "true") {
  requireValue("RESEND_API_KEY", 8);
  requireValue("EMAIL_FROM_ADDRESS", 5);
} else {
  add("WARNING", "REQUIRE_EMAIL_VERIFICATION", "Disabled. Enable only after the staging email sender is verified and tested.");
}

if (value("NEXT_PUBLIC_SHOW_STAGING_UI") !== "true") {
  add("WARNING", "NEXT_PUBLIC_SHOW_STAGING_UI", "Set true on staging to expose test navigation controls.");
}

for (const finding of findings) console.log(`[${finding.level}] ${finding.name}: ${finding.detail}`);
const errors = findings.filter((finding) => finding.level === "ERROR").length;
const warnings = findings.filter((finding) => finding.level === "WARNING").length;
console.log(`\nStaging preflight: ${errors} error(s), ${warnings} warning(s). No secret values were printed.`);
if (errors > 0) process.exit(1);
