# Synthetic payment selector profiling - 21 October 2026

Profiles the existing payment_reconcile and missing_refund_recover SQL builders with ordinary and queue-aware selection. Financial implementation is unchanged.

## Method

- 36 cases: 0, 1,000 and 10,000 payment attempts; two operations; eligible, mixed and cooling distributions; queue selection on/off.
- One warmup and three timed queries per case, checking exact returned IDs and ordering on every query.
- Separate EXPLAIN ANALYZE BUFFERS JSON plans are retained in the raw evidence.
- Selection runs in repeatable-read, read-only transactions. Fixture creation, population and ANALYZE affect temporary tables only.
- Temporary tables copy local column types and indexes. Primary-key NOT NULL requirements remain; other NOT NULL requirements are relaxed. Defaults, foreign keys, checks and triggers are not reproduced.
- Mixed fixtures include price mismatches and legacy refund blockers; cooling excludes every third candidate from queue selection. Other cases retain due or absent metadata.
- Unused columns are null. These are synthetic scheduling candidates, not complete valid financial-worker fixtures.
- Script setup was corrected to preserve primary-key requirements and supply price-component IDs. The completed evidence was retained; no successful profiling run was repeated during close-out.

## Results at 10,000 payment attempts

| Operation | Distribution | Queue selection | Median query ms | EXPLAIN execution ms |
| --- | --- | --- | ---: | ---: |
| payment_reconcile | eligible | false | 36.285 | 37.862 |
| payment_reconcile | eligible | true | 48.047 | 50.907 |
| payment_reconcile | mixed | false | 89.183 | 91.709 |
| payment_reconcile | mixed | true | 99.858 | 99.316 |
| payment_reconcile | cooling | false | 94.548 | 102.576 |
| payment_reconcile | cooling | true | 115.948 | 123.433 |
| missing_refund_recover | eligible | false | 456.175 | 454.290 |
| missing_refund_recover | eligible | true | 499.799 | 555.433 |
| missing_refund_recover | mixed | false | 998.030 | 1473.548 |
| missing_refund_recover | mixed | true | 703.187 | 1056.813 |
| missing_refund_recover | cooling | false | 429.675 | 524.809 |
| missing_refund_recover | cooling | true | 347.345 | 434.535 |

## Interpretation and limits

- The inspected plans process thousands of candidates before top-N sorting returns 25 jobs; the output limit does not bound SQL work.
- Payment-count and historical audit checks execute repeatedly. Mixed historical recovery includes repeated sequential scans of legacy refunds.
- Captured source indexes include only the refunds primary key, without a booking_id index. This is an investigation lead, not approval for a migration or an established production bottleneck.
- Inspected 10,000-row plans report in-memory top-N sorts and zero temporary read/write blocks.
- Timed queries and EXPLAIN execution are separate measurements; their durations can differ.
- Warm single-session results vary across fixtures and execution order. They do not establish isolated causal speedups, latency percentiles, production throughput or capacity.
- Concurrent load, cold-cache behaviour, wider distributions, realistic row widths, larger legacy tables, queue writes, claims and providers remain unmeasured.
- Refund, transfer, reversal and settlement selectors remain outside this profiling stage.
- No application selector changes, indexes, migrations, environment changes, financial activation or provider operations.
- Validation: 36 profiling cases passed exact-ID/order assertions; saved evidence structure and case coverage verified; script syntax passed.
- Existing TypeScript and worker implementations were unchanged; TypeScript and test suites were not rerun for this CJS profiling/documentation stage.

Raw evidence: financial-payment-selector-profile-2026-10-21.json
Command: node --import tsx --env-file=.env.test.local scripts/profileFinancialPaymentSelectors.cjs
The script refuses to overwrite existing evidence. Preserve this checkpoint before any separately planned new run.
