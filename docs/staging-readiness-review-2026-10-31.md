# Staging readiness review — 31 October 2026

## Status
In progress. The staging release readiness milestone has not been reached.

## Reviewed
- Migration runner and generator list migrations 000–047.
- All 48 runner migrations have manifest entries; no extra entries found.
- Existing migration tests cover fresh databases, reruns, legacy bootstrap,
  partial application and schema-definition mismatches.
- Nine schema snapshot tests passed in this session.
- The repository declares one daily sweep at 03:00 UTC.
- Sweep authentication refuses missing configuration and invalid authorization.
- Scheduled charge execution checks its financial feature gate.
- The scheduled charge selector still queries while that gate is disabled.
- Newer refund, transfer and recovery workers were not added to the sweep.

## Changes
- Staging preflight now checks all twelve financial feature gates.
- Each enabled gate is rejected independently.
- Sweep responses now return HTTP 500 and success=false when a top-level
  job block throws, retaining results and listing failedJobs.
- Independent sweep jobs continue after another job block throws.
- Successful sweeps continue to return HTTP 200.
- No automatic retry mechanism was added.

## Validation
- Preflight regression tests: 13 passed.
- Sweep runtime tests: 12 passed, using transpiled route code in a VM
  with mocked dependencies.
- Existing calendar source checks: 7 passed.
- Schema snapshot tests: 9 passed.
- TypeScript and tracked whitespace checks passed after the final changes.
- No real sweep, database job, email or financial provider call was invoked
  by these new tests.

## Limits and remaining work
- Failures swallowed internally by jobs are not detected by the new response
  check, including the existing expired-hold notification catch.
- Returned business-level failure outcomes are not classified by this change.
- Deployed cron execution, monitoring and retry behaviour remain unverified.
- Local disposable-database migration rehearsal completed: 14/14 tests passed.
- Full cumulative source review remains incomplete.
- Isolated deployed staging, upload-completion callback and successful
  Stripe test-mode host onboarding remain outstanding.

## Constraints
No deployment, production migration, financial activation, environment-file
change, commit or normal Git staging change was performed in this stage.

## Disposable-database migration rehearsal
All 14 existing migration integration tests passed on 31 October 2026.
The fresh-database case applied all 48 real migrations.
Coverage included reruns, pre-ledger bootstrap, partial migrations,
rollback on genuine failures and schema-definition mismatches.
The constraint-mismatch diagnostic was expected by a passing rejection test.
Tests used disposable databases on loopback PostgreSQL.
This does not establish compatibility with the deployed staging database.

## Rate-limit and Blob configuration follow-up
- Runtime authentication uses AUTH_SECRET, matching preflight.
- Database connections use lib/db/index.ts.
- Distributed limiting is implemented in root middleware.ts.
- Initial middleware/security run: 18 tests passed.
- Expanded limiter suite: 21 tests passed, including simulated Redis
  outages across authentication, financial, booking activity, AI,
  contact and newsletter requests.
- An ordinary page remained available during the simulated outage.
- Configured Redis errors currently propagate. Tests establish rejection
  without local fallback, not a controlled HTTP 503 response.
- Actual deployed Upstash availability remains unverified.
- Staging preflight now requires BLOB_READ_WRITE_TOKEN.
- Expanded preflight suite: 16 tests passed.
- Missing/ellipsis-placeholder Blob values are rejected, and the output
  test confirms the supplied Blob token value is not printed.
- This is a presence check, not token validity or test-store isolation.
- TypeScript and tracked whitespace checks passed after these changes.
- No environment files, deployed settings or provider resources changed.
