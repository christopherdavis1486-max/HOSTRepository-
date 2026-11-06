# Settlement queue-review profiling ? 21 October 2026

## Measurements

18 real review cases cover 0/100/1000 settlements, execution/reconciliation
and eligible/mixed/cooling distributions. Each uses one warmup and three timed passes.
Real review, transaction handling and financial eligibility execute on an isolated
temporary-table client supplied through an in-process application pool checkout override.
Application source files and environment files are unchanged.

- At 1000 records, total pass medians ranged from 198.628 to 273.303 ms.
- The 25 scheduling writes had summed-query-time medians of 8.594?14.448 ms.
- Uncontended advisory calls had medians of 0.244?0.564 ms at that scale.
- Eligible candidates received 30-second cooldowns; rejected mixed candidates received 60-second initial backoff.
- Exact jobs, query counts, untouched unselected metadata and financial fixture hashes passed.

## Advisory contention

Four scenarios use two distinct local PostgreSQL sessions and 100 fixtures.
For each operation, the holder acquires either the same or the other operation key.
Each scenario uses one warmup and three timed observations, with recovery checks after release.

- Same-operation contention returned empty batches: execution median 1.497 ms; reconciliation 1.226 ms.
- Those passes performed no discovery, eligibility queries or queue writes; metadata remained unchanged.
- The other operation key did not block review: observed medians 191.483 and 206.435 ms.
- Review succeeded after holder rollback released its lock.
- Financial fixture hashes remained unchanged; no financial worker or provider was invoked.

## Interpretation and limits

These are local observations, not latency guarantees or production capacity results.
Temporary writes exclude persistent-table WAL, durability, replication and production maintenance costs.
Pool acquisition is routed directly to the fixture client, so pool wait is excluded.
Fixtures simplify constraints, row widths and host distribution; legacy exclusion tables are empty.
Phase timings include instrumentation; separately calculated phase medians need not sum to total medians.
Earlier selector profiling used a different run and transaction setup; subtracting its timings
from these measurements would not isolate queue overhead reliably.
The holder exercises database-wide advisory keys but does not concurrently mutate shared financial rows.
Sustained load, row-lock conflicts, connection exhaustion, populated exclusions and larger scales remain unmeasured.
Financial snapshot hashes cover the isolated temporary fixtures, not a production database audit.
Successful samples were not rerun during evidence verification or documentation.
TypeScript and application test suites were not rerun for this CJS profiling/documentation stage.
No migrations, financial activation, deployment, commits or normal staging changes.
