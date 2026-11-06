# Settlement selector profiling ? 21 October 2026

## Method

36 synthetic cases: 0/100/1000 settlements, execution/reconciliation,
eligible/mixed/cooling distributions, ordinary/queue-filtered discovery.
Discovery SQL is extracted from the existing implementations; eligibility
uses the real isCancellationSettlementCandidateEligible helper.
Each case uses one warmup, three timed passes and separate saved EXPLAIN plans.
Exact candidate windows and eligible IDs/order passed in every measured pass.

## Findings

- At 1000 records, total pass medians were 163.579?200.767 ms.
- Discovery medians were 0.788?2.428 ms; eligibility medians were 162.549?198.074 ms.
- Fully eligible windows inspect 25 candidates using 75 sequential eligibility queries.
- Mixed windows use 67 eligibility queries and return 19 ordinary or 18 queue-filtered jobs.
- Invalid candidates occupy the bounded window; selection does not refill it.
- Discovery plans scan 1000 bookings and settlements; queue variants perform 1000 queue-index probes.
- Discovery uses an in-memory top-N sort. Inspected plans report zero temporary-block reads/writes.
- Representative evidence joins use indexes; related-record checks scan empty legacy/reversal tables.
- Single-statement EXPLAIN times do not account for the complete pass, client round trips, planning, JSON transfer, JavaScript checks or instrumentation.
- The measurements identify where time is spent, but do not isolate its root cause or justify changing financial authorization.

## Limits and follow-up

Warm single-session local results are not production latency or capacity guarantees.
Fixtures retain local types/indexes and primary-key requirements but simplify
other constraints, defaults, unused fields and production row widths.
One host per booking and one 50 percent cancellation policy are represented.
Legacy payment/refund/payout and reversal tables are empty in these fixtures.
Measurements run inside repeatable-read read-only transactions; ordinary
application discovery can observe changes between its separate reads.
Gate checks, queue writes, advisory locks, transaction setup/commit costs,
claims, dispatch, workers and provider operations are excluded.
Representative eligibility plans cover one candidate per SQL shape, not every rejection.
Three fixed-order samples do not establish percentiles or explain timing variation.
Phase medians are calculated separately and need not sum to the total median.
Larger/skewed datasets, populated exclusion tables, concurrency and complete
queue-review write/lock costs remain to be measured.

No application selector, financial eligibility, index or migration changes.
No persistent fixture writes, provider operations, financial activation or deployment.
TypeScript and test suites were not rerun for this CJS profiling/documentation stage.
