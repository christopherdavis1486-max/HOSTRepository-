# Settlement selection: concentrated host and populated exclusions

24 cases cover 1000/10000 bookings under one shared host, execution/reconciliation,
eligible/mixed/cooling distributions and ordinary/queue-filtered discovery.
Each legacy payments/refunds/payouts table and the reversal table contains
the same number of unrelated rows as there are bookings.
These unrelated rows exercise absence checks without blocking otherwise valid candidates.
Fixture assertions confirm one host and the intended legacy refund count.
The real eligibility helper and extracted existing discovery SQL remain unchanged.

## Results

- All exact candidate-window and eligible-ID/order assertions passed.
- One warmup and three timed passes per case; representative EXPLAIN plans saved separately.
- At 10000 records, total pass medians were 210.534?327.841 ms.
- Queue-filtered discovery medians were 11.717?16.018 ms.
- Fully eligible windows still issue 75 sequential eligibility queries; mixed windows issue 67.
- Representative ordinary execution discovery uses the existing scheduled-release index, visiting 26 settlement rows.
- Queue-filtered discovery scans 10000 settlements/bookings and 6667 queue rows in the inspected eligible plans.
- Reconciliation discovery scans and sorts the candidate population in the inspected eligible plans.
- Related-record checks scan all 10000 legacy refunds and payouts for an absent booking match.
- Other representative evidence joins and exclusion lookups use existing indexes.
- Inspected plans use memory sorts where needed and report zero temporary-block reads/writes.

## Interpretation

Legacy refunds(booking_id) and payouts(booking_id) are candidates for a temporary-index experiment.
This profile alone does not justify a persistent index or establish its build/write/storage costs.
The shared host and populated exclusions change together, so their individual timing effects
cannot be isolated by comparison with an earlier run.
Three warm fixed-order samples do not establish percentiles, production capacity or causation.
Candidate output remains bounded at 25; that does not bound discovery scans or exclusion work.

## Scope and limitations

The experimentDescription field and this document describe the concentrated-host fixture.
The raw report retains generic fixture prose inherited from its source harness;
that inherited prose should not be read as a one-host-per-booking experiment.
Temporary tables simplify constraints, defaults, row widths and production distributions.
One 50 percent cancellation policy and unrelated exclusion rows are represented.
Measurements use repeatable-read read-only transactions and exclude queue writes,
gates, claims, workers, provider operations and concurrent changes.
Representative plans cover one candidate per eligibility SQL shape.
Financial eligibility, application selectors and persistent indexes were unchanged.
TypeScript and test suites were not rerun for this CJS profiling/documentation stage.
No migrations, environment-file changes, activation, deployment or commits.
