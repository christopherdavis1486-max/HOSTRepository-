# Financial monitoring database-clock assessment

Prepared: 21 October 2026.

## Investigation

The original three populated-fixture failures did not capture their unavailable reason.
Ten subsequent isolated runs passed all six tests each.
Read-only clock investigation found PostgreSQL 3-4 milliseconds ahead of Node's
post-query wall clock in all 30 samples. Nine of ten queue snapshots were
classified as future_snapshot, with ages of minus one or minus two milliseconds.
This reproduces a mechanism capable of the earlier behavior; the uncaptured
original failures cannot be attributed conclusively.

## Correction

The combined collector now reads PostgreSQL assessment time after both sources.
Database receipt timestamps and final assessment use the database clock.
Both supplied database connections must refer to the same environment.
Clock reads validate a single finite Date and fail visibly without a Node fallback.
Clock-read failure fails overall collection even if source reads succeeded.
Pure assessors retain strict future and stale checks without added tolerance.
Standalone pure-assessor callers still own their supplied clock.
Database wall-clock corrections can still produce future or stale observations.
No claim is made that every possible intermittent failure is eliminated.

## Validation

140 tests passed across eight monitoring files; zero failures, skips or cancellations.
TypeScript passed. Three new deterministic tests cover database time ahead of Node,
clock-read failure and rejection of a snapshot one millisecond ahead of database time.
Six real database integrations passed with read-only heartbeat and clock reads.
Saved investigation evidence predates the correction and remains unchanged.
The local operator report and wider application suites were not rerun after correction.

No financial worker, authorization, scheduling or provider changes.
No persistent migration application, activation, deployment, environment changes or commits.
Normal staging preserved; stage whitespace checked. No tests rerun during close-out.

The repository copy of the repeated-run log normalizes trailing blank lines only; the original external log is preserved byte-for-byte.
