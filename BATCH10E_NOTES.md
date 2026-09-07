# Batch 10E — Security foundation

## Added

- Shared production rate limiting through Upstash Redis; authentication and financial mutations fail closed in production if it is not configured.
- Same-origin enforcement for state-changing browser API requests, with explicit Stripe webhook and cron exemptions.
- CSP, anti-framing, MIME-sniffing, referrer, permissions, opener and production HSTS headers.
- Centrally revocable sessions using `users.session_version`; suspended users and stale sessions are rejected on every protected route.
- Password resets now revoke all existing sessions.
- Hashed, single-use, 24-hour email verification tokens and a verification completion page.
- Optional production enforcement through `REQUIRE_EMAIL_VERIFICATION=true`.
- Sanitised security-event storage.
- Minimum new/reset password length increased to 12 characters.
- Vulnerable nested PostCSS and Sharp dependencies replaced using constrained package overrides.

## Required production configuration

- `UPSTASH_REDIS_REST_URL`
- `UPSTASH_REDIS_REST_TOKEN`
- `SECURITY_REQUIRE_DISTRIBUTED_RATE_LIMIT=true`
- `RESEND_API_KEY`
- A verified `EMAIL_FROM_ADDRESS`
- `APP_URL=https://your-production-domain`
- `REQUIRE_EMAIL_VERIFICATION=true`

Do not enable email-verification enforcement until outbound email delivery has been tested.

## Verification

- `npm audit`: 0 vulnerabilities
- Focused regression tests: 12 passed
- TypeScript: passed
- Production build: passed

## Next security phase

MFA/passkeys, recovery codes, account-wide session management UI, data export/anonymisation, production monitoring, backup restoration tests and an independent penetration test remain separate launch-gate work.
