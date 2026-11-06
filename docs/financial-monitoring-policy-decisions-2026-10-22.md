# Financial monitoring policy decisions

Prepared: 22 October 2026.

## Evidence and current decision

The inspected repository declares one cron entry: /api/cron/sweep with
expression 0 3 * * *. Its route handles other scheduled platform work;
it does not directly invoke the ten monitored financial entry points.
That cron expression is not evidence of a financial runner heartbeat cadence.
External schedulers, deployed configuration and transitive call paths have
not been exhaustively inspected. Repository configuration does not prove
that any deployment is invoking a runner.

All ten monitored operations remain unknown pending explicit operator intent.
Absence of a schedule does not establish paused status. No existing policy
or financial gate is changed by this document.

| Operation | Draft state | Invocation cadence | Review threshold |
| --- | --- | --- | --- |
| settlement_execute | unknown | undecided | undecided |
| settlement_reconcile | unknown | undecided | undecided |
| payment_reconcile | unknown | undecided | undecided |
| missing_refund_recover | unknown | undecided | undecided |
| refund_execute | unknown | undecided | undecided |
| refund_reconcile | unknown | undecided | undecided |
| transfer_execute | unknown | undecided | undecided |
| transfer_reconcile | unknown | undecided | undecided |
| reversal_execute | unknown | undecided | undecided |
| reversal_reconcile | unknown | undecided | undecided |

## Decisions required before an executable policy

1. Select the environment and identify its schedule owner.
2. Decide which operations should run and which are explicitly paused.
3. For each running operation, record the intended invocation interval,
   expected maximum duration and allowance for scheduling delay.
4. Select the monitoring collection interval and tolerated snapshot age.
5. Choose dueReviewAgeMs separately for each running operation according
   to acceptable queue review delay. This is scheduling metadata, not a
   guarantee of provider completion or financial settlement.
6. Decide how to handle different runner cadences: the current policy has
   one shared maxHeartbeatAgeMs, not a per-operation heartbeat threshold.

## Heartbeat threshold interpretation

The wrapper reports start and completion but sends no periodic pulse.
A legitimate long-running callback can therefore have an old start report.
Choose freshness limits with both invocation gaps and execution duration
in view; document the chosen scheduling allowance.
If one shared limit hides shorter-cadence failures, consider extending
policy support rather than assigning an arbitrary universal threshold.
Recent reporting and returned outcomes do not establish financial success.

## Draft file

financial-monitoring-policy-draft-2026-10-22.json is a decision worksheet.
Its draft_not_executable marker and null values are intentional.
It is not a FinancialMonitoringPolicy and must not be passed to either
report command. No default production thresholds are selected.
Once decisions are made, produce and validate a separate executable policy.

## Scope

Documentation only. No database access, scheduler invocation, heartbeat
collection, migration application, financial activation or notifications.
No environment-file changes, deployment, commits or normal staging changes.
