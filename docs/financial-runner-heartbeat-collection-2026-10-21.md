# Financial runner heartbeat storage and explicit wrapper

Prepared: 21 October 2026.

Migration 047 defines one monitoring record per financial operation.
Starts issue unique run tokens and use database timestamps. A newer start
supersedes the previous monitoring token without excluding concurrent work.
Completion updates require the matching token and an unfinished record.
Repeated or superseded completion leaves metadata unchanged.

The explicit callback wrapper records start before invocation and invokes
the callback once. Start-write failure throws before callback invocation.
After invocation, execution and completion-write outcomes are returned separately.
Callback errors are captured in execution.status='threw'; callers must inspect
this field because callback errors are not rethrown by this wrapper.
Completion-write failure preserves the callback value/error and never retries it.
Returned values and errors are retained in memory, not stored in the heartbeat table.

The reader performs one bounded SELECT and validates stored records.
Missing operations remain absent; database/schema failures propagate.
Stored timestamps integrate with the existing pure heartbeat assessor.
Recent reporting and a returned callback do not establish financial success,
enabled gates, worker progress or provider completion.

Only the latest start is retained; this is not a run-history or active-run registry.
There is no periodic pulse. Long-running callbacks may have stale start reports.
Operation-to-callback association is caller-owned.
Database access, permissions, timeouts and read-only reader policy are caller-owned.
Two-session database contention and process-crash recovery are not established
by the single-session overlapping callback tests.

Migration 047 is registered in the runner and manifest generator.
Its manifest entry was captured from PostgreSQL during a rolled-back rehearsal.
Persistent heartbeat tables were not created and the migration ledger was unchanged.
Full fresh/upgrade migration-runner validation remains outstanding.

Validation: 50 tests passed across three files with concurrency 1;
zero failures, skips or cancellations. TypeScript passed.
Tests use isolated temporary tables for storage, reader and wrapper integration.
Stage whitespace checked separately. Wider application suites were not rerun.

Actual financial runner wiring, cron scheduling, production thresholds,
access-role deployment, notification routing and escalation remain outstanding.
No financial workers or providers were invoked by these tests.
No production deployment, financial activation, environment-file changes or commits.
