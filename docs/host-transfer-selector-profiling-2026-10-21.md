# Synthetic host-transfer selector profiling - 21 October 2026

Profiles the existing execution and reconciliation selection builders. No claims, workers or provider operations are invoked.

## Method

- 36 cases: 0/1,000/10,000 entitlements; two operations; eligible/mixed/cooling fixtures; ordinary/queue selection.
- One warmup and three timed queries per case; exact selected IDs and ordering checked on every query.
- Separate EXPLAIN ANALYZE BUFFERS JSON plans retained.
- Temporary copies retain local column types and indexes. Non-primary NOT NULL constraints are relaxed; defaults, checks, foreign keys and triggers are omitted. Unused fields remain null.
- One host per booking. Execution bookings are confirmed; reconciliation bookings are cancelled. These distributions do not model hosts with many bookings.
- Mixed fixtures include entitlement payout mismatches and legacy refunds. Execution excludes those refund blockers; reconciliation preserves its existing broader selection predicates.
- Mixed/cooling queue fixtures place every third entitlement in cooldown; other metadata is due or absent.
- All selection transactions are read-only; fixture population and ANALYZE affect temporary tables only.
- These are discovery fixtures, not complete financial-worker authorization fixtures.

## Results at 10,000 entitlements

| Operation | Distribution | Queue | Median query ms | EXPLAIN execution ms |
| --- | --- | --- | ---: | ---: |
| transfer_execute | eligible | false | 423.035 | 436.117 |
| transfer_execute | eligible | true | 468.214 | 497.441 |
| transfer_execute | mixed | false | 284.054 | 297.108 |
| transfer_execute | mixed | true | 284.268 | 257.849 |
| transfer_execute | cooling | false | 424.199 | 474.669 |
| transfer_execute | cooling | true | 407.495 | 380.773 |
| transfer_reconcile | eligible | false | 147.709 | 144.593 |
| transfer_reconcile | eligible | true | 178.620 | 188.498 |
| transfer_reconcile | mixed | false | 117.416 | 121.243 |
| transfer_reconcile | mixed | true | 137.245 | 175.329 |
| transfer_reconcile | cooling | false | 133.362 | 143.272 |
| transfer_reconcile | cooling | true | 187.791 | 175.127 |

## Findings and limits

- Thousands of eligibility lookups and exclusion checks precede the 25-job output limit.
- Mixed execution plans scan the populated legacy-refunds fixture once; do not transfer the historical-recovery repeated-scan finding to this query.
- Inspected execution plans use booking host-ID lookup, while reconciliation uses booking primary-key lookup; one-host-per-booking fixtures limit conclusions about this difference.
- Inspected top-N sorts stay in memory; reported temporary read/write blocks are zero.
- Timing differences across operations and fixtures do not establish isolated causal speedups or production capacity.
- Concurrent load, realistic host skew, larger exclusion tables, cold cache, queue-write costs and financial claims/workers remain unmeasured.
- Reversal and settlement selectors remain outside this profile.
- Validation: 36 profiling cases passed; saved evidence coverage, script syntax and stage whitespace verified.
- Profiling cases are not test-suite counts. TypeScript and test suites were not rerun for this CJS profiling/documentation stage.
- No selector/index changes, migrations, persistent fixture writes, deployment, activation or environment changes.

Raw evidence: host-transfer-selector-profile-2026-10-21.json
Command: node --import tsx --env-file=.env.test.local scripts/profileHostTransferSelectors.cjs
The script refuses to overwrite existing evidence.
