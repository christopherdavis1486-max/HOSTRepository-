# Settlement legacy financial index trial ? 21 October 2026

## Method

40 cases: 1000/10000 concentrated-host bookings, execution/reconciliation,
ordinary/queue-filtered discovery and five fixed-order index variants:
baseline_before, refunds_only, payouts_only, both, baseline_after.
Each case uses one warmup, three timed passes and separate EXPLAIN plans.
Only temporary nonunique btree indexes on refunds(booking_id) and payouts(booking_id) are varied.
Unrelated legacy financial rows exercise absent-match eligibility checks.
Exact candidate windows and eligible IDs/order passed throughout; discovery
and all eligibility SQL hashes are unchanged within each five-variant group.

## Plan findings at 10000 records

- Baselines scan all 10000 rows of each legacy refunds and payouts table.
- Refunds-only replaces the refund scan with an index-only lookup; payouts still scan.
- Payouts-only replaces the payout scan with an index-only lookup; refunds still scan.
- Both indexes replace both scans; each lookup uses two local buffer hits instead of 84.
- Representative combined related-record checks with both indexes take 0.055?0.083 ms.
- Baseline-after restores both scans, confirming the access-path change is reversible.
- All variants retain 75 sequential eligibility queries for each fully eligible 25-candidate window.

## Timing interpretation

Whole-pass medians vary substantially and do not show a consistent overall improvement.
For example, ordinary execution at 10000 records measured 266.058 ms before,
242.593 ms with both indexes and 208.854 ms after removal.
Queue reconciliation measured 256.043 ms before, 185.173 ms with both and 225.021 ms after.
These observations support reduced exclusion-query work, not a reliable overall speed-up estimate.
Representative EXPLAIN times are single observations and are not whole-pass latency percentiles.

## Decision and limitations

Keep both booking-ID indexes as candidates for persistent-table rehearsal.
No persistent index or migration is introduced by this checkpoint.
Build time, storage, write amplification, lock behavior, durability and deployment
costs remain unmeasured and must inform any later migration decision.
Variant order is fixed; fixtures are warm, simplified and local, with one shared host
and one cancellation policy. This is not a randomized or production-capacity study.
Only absent legacy matches and eligible settlements are measured in this trial.
Queue writes, workers, providers and concurrent load remain excluded.
Generic inherited fixture prose is superseded by experimentDescription and this document.
Successful measurements were not rerun during evidence inspection or close-out.
Syntax and whitespace checked; TypeScript and test suites not rerun.
No application eligibility changes, financial activation, deployment, environment changes or commits.
