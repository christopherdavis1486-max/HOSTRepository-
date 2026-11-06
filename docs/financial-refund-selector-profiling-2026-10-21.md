# Synthetic refund selector profiling - 21 October 2026

Profiles existing refund_execute and refund_reconcile selection builders, with ordinary and queue selection. Financial implementation is unchanged.

## Method

- 36 cases: 0/1,000/10,000 refunds; two operations; eligible/mixed/cooling distributions; queue selection on/off.
- One warmup and three timed queries per case; exact selected IDs/order checked on every query.
- Separate EXPLAIN ANALYZE BUFFERS JSON plans retained in the raw evidence.
- Temporary tables copy local column types and indexes. Non-primary NOT NULL constraints are relaxed; defaults, foreign keys, checks and triggers are omitted. Unused fields are null.
- Mixed fixtures make every refund with i % 10 >= 8 exceed its payment amount.
- In mixed/cooling fixtures, every third refund has future queue metadata; other metadata is due or absent. Ordinary selection bypasses these hints.
- Execution fixtures are pending and unclaimed; reconciliation fixtures are processing with a token/start timestamp and a cleared lease.
- Selection transactions are read-only. Fixture population and ANALYZE affect temporary tables only.
- These are selector fixtures, not complete financial-worker authorization fixtures.

## Results at 10,000 refunds

| Operation | Distribution | Queue | Median query ms | EXPLAIN execution ms |
| --- | --- | --- | ---: | ---: |
| refund_execute | eligible | false | 28.626 | 33.199 |
| refund_execute | eligible | true | 40.584 | 44.118 |
| refund_execute | mixed | false | 28.584 | 30.176 |
| refund_execute | mixed | true | 37.907 | 38.719 |
| refund_execute | cooling | false | 80.788 | 67.429 |
| refund_execute | cooling | true | 114.568 | 131.007 |
| refund_reconcile | eligible | false | 81.497 | 84.662 |
| refund_reconcile | eligible | true | 119.295 | 120.332 |
| refund_reconcile | mixed | false | 84.485 | 77.996 |
| refund_reconcile | mixed | true | 100.419 | 114.579 |
| refund_reconcile | cooling | false | 78.779 | 90.847 |
| refund_reconcile | cooling | true | 116.040 | 143.623 |

## Findings and limits

- Inspected plans scan 10,000 refund rows and 10,000 payment rows before returning 25 jobs.
- Booking lookups and payment-count checks repeat thousands of times. Queue cooldown filtering reduces output candidates without necessarily avoiding earlier eligibility work.
- Inspected sorts use in-memory top-N heapsort; reported temporary read/write blocks are zero.
- Timings vary substantially across otherwise similar fixtures. Fixed execution order and warm-cache conditions do not establish isolated causal performance differences.
- No index or query change is proposed from this evidence alone.
- No concurrent load, cold-cache measurements, realistic row widths, larger scales, queue-write costs, worker execution or provider operations were measured.
- Transfer, reversal and settlement selectors remain outside this profile.
- Validation: 36 profiling cases passed exact-ID/order assertions; saved evidence coverage, syntax and stage whitespace verified.
- Profiling cases are not project test counts. TypeScript and test suites were not rerun for this CJS profiling/documentation stage.
- No persistent fixture writes, migrations, financial activation, deployment or environment changes.

Raw evidence: financial-refund-selector-profile-2026-10-21.json
Command: node --import tsx --env-file=.env.test.local scripts/profileFinancialRefundSelectors.cjs
The script refuses to overwrite existing evidence.
