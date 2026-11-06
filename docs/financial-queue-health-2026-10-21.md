# Financial queue scheduling health

Prepared: 21 October 2026.

`readFinancialQueueHealth(pool)` returns aggregate scheduling metadata for ten
operations in a repeatable-read, read-only transaction. It checks out and
releases its own connection. Call it outside an existing transaction.

This module has no API, cron, scheduler or provider wiring. It does not invoke
financial selectors or workers, change gates, claim records, refresh cooldowns
or delete metadata. It can report while financial gates are disabled.

## Fields

- total: number of stored queue review rows.
- due / cooling: next review time at or before / after the snapshot timestamp.
- selectedAwaitingFeedback: last scheduling outcome is selected, at any age.
- selectedDue: selected rows whose scheduling cooldown has elapsed.
- unresolved: last outcome is unresolved or settlement review_required.
- backingOff: unresolved rows with a positive failure count and a future review.
- resolved: scheduling feedback was resolved; this is not a financial audit.
- eligible: settlement eligibility review succeeded; this is not worker completion.
- maxReviewFailures: greatest stored failure count for the operation.
- oldestDueAt / oldestReviewedAt: earliest matching scheduling timestamps.

Counts are decimal strings, preserving PostgreSQL bigint precision. Empty
operations appear with zero counts and null timestamps. Selected rows may
remain selected because dispatch stopped or feedback failed; these rows do
not prove an active worker, failed worker or stuck financial claim.

## Interpretation and limitations

The report excludes eligible financial records that have never entered queue
metadata. It does not measure the full financial backlog, verify current
eligibility, detect orphan metadata, inspect active claims or establish
provider or financial completion. Historical or orphan metadata may contribute
to counts. No automatic cleanup or replay follows from this report.

All ten operations use one database snapshot. Results expose no record IDs,
provider references, guest information, credentials or financial amounts.

The query scans all queue metadata. Ten output rows do not bound SQL work.
A two-second lock timeout and five-second statement timeout apply per
statement, not to the overall report or pool connection wait. Monitoring
frequency, capacity profiling and alert thresholds require separate review.

Missing schemas, query errors and malformed results fail visibly rather than
being represented as empty or healthy queues. Read-only queries still acquire
normal PostgreSQL access-share locks and may briefly interact with schema DDL.

## Local operator command

From the repository root:

```powershell
node --import tsx --env-file=.env.test.local .\scripts\reportFinancialQueueHealth.ts
```

The command requires loopback host_test, verifies the connected database and
read-only session default, and prints JSON. It never prints the connection
string. A failure returns a nonzero exit code with a generic message and,
where available, the PostgreSQL error code. No environment file is changed.

Local smoke verification on 21 October 2026 returned all ten operations
with zero stored review rows. This does not establish an empty financial
backlog or financial health. The 25 isolated database tests passed; TypeScript
passed. The wider project suite was not rerun.
