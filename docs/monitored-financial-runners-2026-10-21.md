# Explicit monitored financial runner entry points

Prepared: 21 October 2026.

Four new modules provide explicit monitored entry points for all ten operations:
payment reconciliation, missing-refund recovery, refund execution/reconciliation,
reversal execution/reconciliation, settlement execution/reconciliation and
host-transfer execution/reconciliation.

Inputs are validated before monitoring writes. Options are copied before
awaiting heartbeat I/O so caller mutation cannot change the subsequent call.
Each entry point delegates once to the existing selected runner.
Transfer execution forwards the claim identity; transfer reconciliation uses
the existing reconciliation pass, preserving expiry-before-selection ordering.

Existing direct callers, selectors, financial gates and workers remain unchanged.
There is no scheduler, API route, cron wiring or automatic retry.
Heartbeat I/O is outside the selected runner's soft time budget.
The monitoring database connection is supplied by the caller; financial work
continues to use the existing application's database connection.
Callers must ensure these connections refer to the intended same environment.

Start-write failure prevents runner invocation. After invocation, execution
and heartbeat-write outcomes are returned separately. Callers must inspect
execution.status; captured runner errors are not rethrown.
A completion-write failure never causes a second runner invocation.
A returned runner, disabled result or recent heartbeat does not establish
financial success, enabled gates or provider completion.

Validation: 93 tests passed across seven files with concurrency 1;
zero failures, skips or cancellations. TypeScript passed.
The entry-point tests mock the selected runners. Separate storage/wrapper tests
exercise real PostgreSQL temporary tables and token fencing.
This combined run does not exercise actual financial workers through the new
entry points or establish two-session contention behavior.
Migration tests passed earlier and were not rerun in this combined validation.
Stage whitespace checked separately; wider application suites were not rerun.

Migration 047 remains unapplied to persistent host_test and production tables.
Operational scheduling, monitoring policy, connection timeouts, access roles,
alert routing and escalation remain outstanding.
No provider operations, production deployment, financial activation,
environment-file changes or commits.
