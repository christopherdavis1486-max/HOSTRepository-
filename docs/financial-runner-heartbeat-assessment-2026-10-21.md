# Financial runner heartbeat assessment

Prepared: 21 October 2026.

The pure assessor accepts caller-supplied operation heartbeat timestamps,
explicit expected runner states and a positive maximum heartbeat age.
It returns all ten financial operations without database or environment access.

Running operations report recent, missing, stale or future status.
A timestamp exactly at the maximum age remains recent.
Paused status requires explicit operator policy; silence never implies pause.
Absent or unknown runner policy requires configuration.
Malformed, duplicate and unknown reports fail visibly, including when paused.

A recent timestamp establishes reporting recency only. It does not verify
the source of the report, financial gates, worker progress, dispatch success
or financial completion. Caller timestamps require a trusted collection path.
Paused and unknown policy suppress freshness conclusions, while retaining
the supplied timestamp for inspection.

This stage does not collect or persist heartbeats, connect to runners,
schedule monitoring, choose production thresholds or send notifications.
The existing scheduling-health assessor remains unchanged.
Heartbeat collection, restart/overlap handling, trusted source identity,
monitor integration, routing and escalation remain outstanding.

Validation: 16 tests passed in one file with concurrency 1; zero failures,
skips or cancellations. TypeScript passed. Stage whitespace checked separately.
Existing monitoring and financial worker suites were not rerun.
No migrations, financial activation, deployment, environment-file changes,
commits or normal staging changes.
