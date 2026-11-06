# Monitored financial entry points with actual workers

Prepared: 21 October 2026.

44 new integration cases exercise all ten monitored operations using real
selected runners, financial workers and local PostgreSQL fixtures, with mocked Stripe.

- Payment reconciliation: eight cases covering succeeded, canceled, processing and absent evidence.
- Missing-refund recovery: four cases covering verified or unavailable evidence.
- Refund execution and reconciliation: eight cases.
- Reversal execution and reconciliation: eight cases.
- Settlement execution and reconciliation: eight cases.
- Host-transfer execution and reconciliation: eight cases.

Each provider-outcome scenario runs with heartbeat completion succeeding or
failing. Completion failures preserve returned financial outcomes and leave
unfinished monitoring metadata without automatically repeating the runner.
Existing financial-state, authorization, provider-call, queue-backoff and
replay-refusal assertions are retained where applicable.
Refund and settlement execution include uncertain provider outcomes.
Reconciliation includes verified and unresolved evidence; relevant existing
expiry-first paths remain exercised for transfer, reversal and settlement.

Heartbeat tables are temporary on dedicated local host_test connections.
Financial fixtures use the existing worker-test setup in local host_test;
they are not all temporary or globally rolled back. Queue metadata for each
new fixture is removed by test cleanup. Environment flags are restored.
No real Stripe requests or persistent heartbeat migration application.

Validation: all 673 tests passed across the nine changed worker-test files
with concurrency 1; zero failures, cancellations or skips. TypeScript passed.
This total includes the 44 new cases. Stage whitespace checked separately.
The earlier seven-file 93-test run is separate evidence and is not added to
this run's count. The wider project suite was not rerun.

Only test files and documentation changed in this stage.
Live provider behavior, two-session heartbeat contention, process crashes,
scheduler wiring, monitoring configuration and alert delivery remain outside scope.
No production deployment, financial activation, commits or normal staging changes.
