# Legacy financial index operational rehearsal ? 21 October 2026

## Scope

Three uniquely named disposable local databases were created and removed.
The refunds and payouts fixtures were ordinary logged tables with local column
types, NOT NULL requirements and existing indexes. Defaults, checks, foreign
keys and triggers were omitted. No application workers or providers were invoked.
The source host_test tables received no rehearsal data or trial indexes.

## Builds and storage

Eight cases cover two tables, 10000/100000 rows and regular/concurrent builds.
Each build was observed once; valid, ready, nonunique index state and removal passed.
At 100000 rows, regular builds took 73.269?95.793 ms and concurrent builds
94.229?135.096 ms. Each index occupied 3178496 bytes, about 3.03 MiB.
At 10000 rows each occupied 335872 bytes, or 328 KiB.
These are warm local observations without concurrent workload, not deployment estimates.

## Writes

Twelve cases compare baseline_before, indexed and baseline_after on each table
at both scales, with one warmup and three timed samples.
Each transaction inserts 1000 rows, changes their amount, changes their booking
IDs and commits. Values, affected counts and cleanup passed.
At 10000 rows, refund transaction medians were 24.885/31.115/27.131 ms;
payout medians were 28.873/33.979/34.381 ms.
At 100000 rows, refund medians were 49.381/53.350/156.134 ms;
payout medians were 167.895/195.187/148.468 ms.
The additional index adds maintenance work, but large baseline variation prevents
a dependable percentage overhead estimate from this fixed-order experiment.
Freshly inserted-row updates and cleanup-generated dead tuples limit generalisation.
WAL volume, replication effects and arbitrary production update patterns were not measured.

## Locks and failed-build cleanup

Four controlled scenarios cover both tables at 10000 rows.
Regular-build transactions retained their locks after index creation; a second
session's writer hit its 100 ms lock timeout, then succeeded after build commit.
Observed blocked durations were 109.945 and 114.392 ms.
Pre-existing writers caused concurrent builds to hit their 200 ms lock timeout
after 205.544 and 213.073 ms. Both left an invalid catalog entry.
The invalid indexes were inspected, removed concurrently, successfully rebuilt
as valid/ready indexes and removed again.
The deliberate transaction hold is not a measurement of normal build blocking duration.
These scenarios do not cover every concurrent-build failure phase or sustained load.

## Decision

The earlier selector trial demonstrated reduced exclusion-query scans, while
whole-pass speed-up remained inconsistent. This rehearsal adds local build,
storage, write and failure-handling evidence but does not approve a production migration.
Any later index change needs an explicit deployment approach, catalog-state checks,
timeouts and failed-index recovery. Concurrent builds require an execution path
outside the migration runner's per-file transaction.
No application migration or persistent index was added by this stage.

All saved reports passed structural verification and record database removal.
Syntax and stage whitespace checked; no rehearsal reruns during close-out.
TypeScript and application test suites were not rerun.
No financial activation, production deployment, environment changes or commits.
