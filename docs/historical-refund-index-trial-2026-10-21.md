# Historical refund temporary-index experiment - 21 October 2026

Compared unchanged missing_refund_recover selection SQL before, with and after removing a temporary nonunique btree index on refunds(booking_id).

- Twelve cases: 1,000/10,000 payment candidates; ordinary/queue selection; three index variants.
- Mixed fixtures contain 100/1,000 legacy refund blockers and price mismatches. Queue fixtures also include cooling rows.
- Identical fixtures within each comparison; exact IDs/order checked in one warmup and three timed queries per variant.
- Separate EXPLAIN ANALYZE BUFFERS JSON plans retained. Index creation cost is outside query timings.
- All fixture writes, index creation and index removal affect temporary objects only. Selection transactions are read-only.

| Candidates | Queue | Variant | Median query ms | EXPLAIN execution ms |
| ---: | --- | --- | ---: | ---: |
| 1000 | false | baseline_before | 18.755 | 20.506 |
| 1000 | false | temporary_index | 19.652 | 19.773 |
| 1000 | false | baseline_after | 19.539 | 20.346 |
| 1000 | true | baseline_before | 16.150 | 15.186 |
| 1000 | true | temporary_index | 16.322 | 28.106 |
| 1000 | true | baseline_after | 15.526 | 15.306 |
| 10000 | false | baseline_before | 404.592 | 1486.806 |
| 10000 | false | temporary_index | 339.159 | 346.923 |
| 10000 | false | baseline_after | 992.380 | 1527.364 |
| 10000 | true | baseline_before | 640.051 | 1125.047 |
| 10000 | true | temporary_index | 263.171 | 266.204 |
| 10000 | true | baseline_after | 737.539 | 1076.955 |

## Findings

- At 10,000 candidates, the temporary index changed refund access from repeated sequential scans to index-only scans; removing it restored sequential scans.
- Ordinary selection performed 8,000 refund probes; queue selection performed 5,334. These counts remain much larger than the 25 returned jobs.
- At 1,000 candidates, PostgreSQL retained sequential scans even with the trial index; timings showed no clear improvement.
- All twelve cases preserved expected selected IDs/order, and selection SQL hashes matched within each comparison.
- Evidence supports the index as a candidate for further evaluation, not a demonstrated production bottleneck or capacity guarantee.

## Limitations and next steps

- Fixed before/index/after order, warm cache and substantial baseline variation limit causal timing precision.
- Temporary fixtures copy local types/indexes, relax non-primary NOT NULL constraints and omit defaults, checks, foreign keys and triggers. Unused columns are null.
- Index-only plan labels do not establish zero heap fetches; consult the full retained plans.
- Production distributions, larger legacy tables, concurrent load, write overhead, index size and build/lock behaviour remain unmeasured.
- No persistent index, migration, financial worker change, provider operation, deployment or activation was introduced.
- Validation: twelve profiling cases passed; saved evidence and script syntax verified. Profiling cases are not test-suite counts.
- TypeScript and test suites were not rerun for this CJS experiment/documentation stage.
- Other financial selectors remain to be profiled.

Raw evidence: historical-refund-index-trial-2026-10-21.json
Command: node --import tsx --env-file=.env.test.local scripts/profileHistoricalRefundIndexTrial.cjs
The script refuses to overwrite existing evidence.
