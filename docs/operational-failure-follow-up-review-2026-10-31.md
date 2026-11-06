# Operational failure follow-up review — 31 October 2026

## Scope
Source reviewed:
- app/api/cron/sweep/route.ts
- lib/payments/runWithFinancialRunnerHeartbeat.ts
- lib/booking/cancelBooking.ts

This is a scoped operational supplement. It does not establish deployed
monitoring, delivery, alert routing or complete release readiness.

## Cancellation committed; refund initiation failed
Cancellation can commit before refund initiation fails.
The wrapper preserves cancellation success and returns refundError.
Guest notification wording selects needs_review.

Operator handling:
- Confirm the booking's committed state and payment-flow version.
- Inspect the existing refund records and verified provider evidence.
- Treat a provider timeout or missing local provider reference as uncertain.
- Do not repeat cancellation to retry the refund.
- Do not create a replacement refund or reset execution ownership merely
  because the first request returned an error.
- Use the appropriate reviewed recovery process after establishing the
  provider outcome, retaining existing identifiers and idempotency history.

The reviewed wrapper logs the failure but does not create a durable
operational follow-up task. The trip warning is held in page memory.
Absence of a refund record does not establish that no refund is owed.

## Cancellation notification failed
The wrapper returns notificationError separately from refundError.
Cancellation remains committed.

Operator handling:
- Check which messages or notifications were actually persisted or delivered.
- Avoid repeating cancellation or refund execution to resend a notification.
- Check for partial delivery before any controlled resend.
- Record the follow-up and outcome outside the transient browser warning.

No automatic notification retry was added by the reviewed changes.
Durable follow-up ownership and deployed delivery monitoring remain open.

## Cron sweep failures
Missing cron configuration returns 503; invalid authorization returns 401.
Authorized jobs run in separate try/catch blocks.
Top-level result keys ending in Error produce success=false and HTTP 500.
Other jobs may already have committed work before that response.

Limits:
- HTTP 500 does not mean the entire sweep rolled back.
- HTTP 200 means no top-level Error result was recorded; it does not prove
  every per-item operation or notification succeeded.
- Expired-hold notification exceptions are logged inside the loop and do
  not produce a top-level failedJobs entry.
- Scheduled charge outcomes are returned per booking and require inspection.
- Failures caught internally by helpers may not reach the route's catch blocks.

Operator handling:
- Inspect failedJobs, individual outcomes and correlated server logs.
- Establish what committed before considering a targeted retry.
- Do not blindly replay the whole sweep after partial failure.
- Investigate missing expected invocations as well as explicit failures.

Deployed alerting for these conditions remains unverified.
New financial workers remain outside the daily sweep.

## Financial runner heartbeat interpretation
The wrapper is explicit opt-in and does not schedule or retry workers.
A start-write failure throws before the callback is invoked.
After invocation, execution and heartbeat completion outcomes are separate.

- execution=returned means the callback returned, not that funds moved.
- execution=threw may follow partial committed work.
- heartbeat=write_failed may follow completed financial work.
- heartbeat=superseded does not establish that the callback failed.
- No periodic pulse is emitted; a long callback can have a stale start report.

Operator handling:
- Inspect operation results and authoritative financial records.
- Do not replay financial work solely to repair heartbeat reporting.
- Check for concurrent or interrupted execution before any recovery.
- Keep heartbeat health distinct from financial outcome.

## Remaining release work
- Assign operational responsibility and a durable follow-up mechanism.
- Verify deployed logs, alerts, cron invocation visibility and delivery evidence.
- Finish cumulative source review and justified regression checks.
- Rebuild with the latest export and financial gate corrections.
- Verify staging resource isolation and the direct database connection.
- Complete staging preflight and deployed integration acceptance.

Staging release readiness has not been reached.

## Validation and constraints
Read-only source review followed by documentation only.
No new tests were run for this documentation stage.
Earlier financial gate validation remains 464 passing tests.
No deployment, remote database operation, production migration,
financial activation, environment-file change, commit or normal Git staging change.
