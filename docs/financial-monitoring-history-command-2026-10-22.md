# Explicit local financial monitoring history command

Prepared: 22 October 2026.

## Behaviour

The new reportFinancialMonitoringHistory command accepts three arguments:
policy JSON, previous snapshot path or explicit dash, and next snapshot path.
Dash explicitly starts a new history. A missing named previous snapshot fails
rather than silently starting over. Operators must select the correct chain.
The next snapshot must not exist; previous snapshots are never replaced.

The collector now exposes validated source inputs and database assessment time.
Its existing assessment-only API remains available through the same collection
path. Source reads are unchanged; the wrapper reuses the pure assessment.

The command preserves loopback host_test identity guards, read-only database
sessions and bounded connection, statement and lock timeouts.
It loads prior history, collects monitoring metadata, retains conditions and
saves the next snapshot before printing output.
Exit 0 means no pending monitoring conditions; exit 2 includes active and
retained unconfirmed conditions. CLI failures use exit 1 and generic stderr.
No exit code establishes financial success or production readiness.

## Validation

Latest focused run: ten in-process command integrations passed in one file;
zero failures, skips or cancellations. TypeScript passed.
Seven cases cover fresh snapshot creation and monitoring exit decisions.
A three-snapshot chain retains ten missing-heartbeat conditions while schema
is unavailable, then clears them and the source condition after recent reports.
Earlier snapshot bytes remain unchanged and saved state reloads correctly.
Missing/corrupt prior state fails before pool creation. A missing output parent
causes save failure, pool cleanup and no success output.

The preceding run passed 23 command/collector tests across three files.
Those results overlap this latest run and must not be added.
Database fixtures use temporary tables; snapshots use disposable folders.
The command main function is invoked in-process with an explicit fixture pool.
Separate-process restart, full child CLI exit handling, killed writers,
power-loss durability and concurrent history-chain updates remain untested.

## Operational limits

No operational snapshot chain, production policy or scheduler was created.
Snapshot selection, trusted storage, environment separation and permissions
remain caller-owned. State is not authenticated or environment-bound.
A failure after publication, including cleanup or output failure, can leave a
valid next snapshot. Inspect it before retrying; do not blindly restart history.
Database clock failure prevents a new snapshot; the earlier snapshot remains.
No latest pointer, incident archive, delivery receipts, reminders or escalation.

Stage whitespace checked separately; no tests rerun during close-out.
No financial workers/providers invoked, persistent migrations applied,
financial activation, deployment, environment-file changes or commits.
