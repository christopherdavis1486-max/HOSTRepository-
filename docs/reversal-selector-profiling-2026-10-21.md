# Synthetic reversal selector profiling - 21 October 2026

Profiles existing reversal execution/reconciliation selection with the real reversalFinancialEligibility predicate. No claims, workers or provider operations are invoked.

## Method

- 36 cases: 0/100/1,000 reversals; two operations; eligible/mixed/cooling fixtures; ordinary/queue selection.
- One warmup and three timed queries per case, checking exact returned IDs/order throughout; separate EXPLAIN ANALYZE BUFFERS JSON plans retained.
- Fixtures model a paid guest cancellation with a 50 percent refund: payment 24,000, refund 12,000, original transfer 20,000, reversal 10,000 and retained amount 10,000 minor units.
- Matching cancellation audit JSON and refund records exercise the actual eligibility SQL; the financial predicate is not mocked.
- Mixed fixtures include reversal amounts inconsistent with policy and legacy-refund blockers.
- Queue ordering checks never-reviewed rows first, then reviewed rows by last review and requested time. Mixed/cooling fixtures exclude every third row through cooldown metadata.
- Temporary tables retain local types/indexes. Non-primary NOT NULL constraints are relaxed; defaults, checks, foreign keys and triggers are omitted. Unused fields are null.
- One host/booking/entitlement per reversal; all reviews share one historical timestamp. Diverse host workloads, policies and review ages are not represented.
- Selection transactions are read-only; fixture writes and ANALYZE affect temporary tables only.

## Results at 1,000 reversals

| Operation | Distribution | Queue | Median query ms | EXPLAIN execution ms |
| --- | --- | --- | ---: | ---: |
| reversal_execute | eligible | false | 111.748 | 104.602 |
| reversal_execute | eligible | true | 126.303 | 126.494 |
| reversal_execute | mixed | false | 126.955 | 119.423 |
| reversal_execute | mixed | true | 130.889 | 126.435 |
| reversal_execute | cooling | false | 119.170 | 105.086 |
| reversal_execute | cooling | true | 123.739 | 98.868 |
| reversal_reconcile | eligible | false | 107.005 | 97.922 |
| reversal_reconcile | eligible | true | 129.305 | 113.625 |
| reversal_reconcile | mixed | false | 132.919 | 113.005 |
| reversal_reconcile | mixed | true | 123.989 | 115.010 |
| reversal_reconcile | cooling | false | 117.683 | 106.290 |
| reversal_reconcile | cooling | true | 126.488 | 109.207 |

## Findings and limits

- Candidate materialization and financial evidence checks process the fixture population despite returning only 25 jobs.
- Inspected eligibility lookups repeat up to 1,000 times. Queue cooldown filtering does not avoid all earlier financial eligibility work.
- Mixed plans repeatedly scan the populated legacy-refunds fixture. This is a further investigation lead, not a demonstrated production bottleneck.
- Inspected top-N sorts stay in memory and report zero temporary read/write blocks.
- Medians at 1,000 reversals range from 111.748-130.889 ms for execution selection and 107.005-132.919 ms for reconciliation selection.
- These warm synthetic single-session results are not production capacity, latency percentile or concurrency guarantees.
- Larger reversal scales, realistic host skew, diverse cancellation evidence, larger exclusion tables, cold cache and concurrent workloads remain unmeasured.
- Queue writes, claims, workers and providers are outside this profile. Settlement selectors remain unprofiled.
- No selector/index changes or migration proposed in this stage.
- Validation: 36 profiling cases passed exact IDs/order; evidence coverage, script syntax and stage whitespace verified.
- Profiling cases are not project test counts. TypeScript and test suites were not rerun for this CJS profiling/documentation stage.
- No persistent financial fixture writes, provider operations, activation, deployment or environment-file changes.

Raw evidence: reversal-selector-profile-2026-10-21.json
Command: node --import tsx --env-file=.env.test.local scripts/profileReversalSelectors.cjs
The script refuses to overwrite existing evidence.
