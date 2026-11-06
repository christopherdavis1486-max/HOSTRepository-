# Local production-build browser validation - 28 October 2026

## Environment
- Used the existing isolated Next.js 15.5.28 production build.
- Server bound to 127.0.0.1:3000 with loopback host_test configured.
- All twelve ENABLE_* feature flags were false.
- Stripe used a placeholder key; Resend and Blob credentials were empty.
- Upstash client pointed to a local HTTP fixture at 127.0.0.1:8079.
- No application middleware or production security policy was changed.

## Local limiter fixture
- Added scripts/localRateLimitFixture.cjs.
- Fixture supports the inspected single-region sliding-window Lua command.
- Unsupported scripts and Redis commands are rejected.
- Installed Upstash client compatibility check allowed five requests, blocked
  the sixth and allowed a separate identifier independently.
- Seven commands were handled with zero unsupported-command rejections.
- The six sequential results were checked against timeout fallback.
- This in-memory fixture is not Redis and does not establish real Upstash,
  distributed concurrency or production rate-limiter acceptance.

## Browser evidence
- User reported successful private-window sign-in with the existing fixture:
  host-onboarding-20261024@example.test.
- Completion page displayed "A few more details are needed."
- Consent page displayed both consent boxes unchecked and the continue button
  appearing disabled. No consent submission was requested.
- Earlier cumulative captures showed occasional session requests. Their precise
  triggers were not established.
- Source inspection found no configured polling interval; NextAuth supports
  visibility-change and cross-tab session refreshes.
- Final capture followed a request to reload once and wait 30 seconds.
- It showed an initial session request, CSRF request, another session request
  and one onboarding-status request, all HTTP 200.
- No repeating sequence appeared in that final supplied capture.
- The screenshot itself does not independently prove the full idle duration.
- Evidence supports the completion sequence settling in this local check;
  it does not prove that every session request trigger has been explained.

## Limits and close-out
- Existing fixture already had host access; fresh-host promotion was not tested.
- Successful Stripe onboarding, image uploads and complete publication remain
  unverified by this check.
- Real Upstash acceptance and deployed staging verification remain outstanding.
- The bundled Vercel Zod assessment remains open.
- User confirmed both local servers were stopped.
- No deployment, migration, financial activation, environment-file change or
  commit. No real Stripe or email request was submitted during this workflow.
- Source checkpoints do not back up the local database.
