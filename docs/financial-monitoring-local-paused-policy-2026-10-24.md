# Local paused monitoring policy

Prepared: 24 October 2026.

## Operator decision

Owner: Gary Christopher Davies.
Scope: local loopback host_test only; monitoring is manually invoked.
All ten monitored operations are intentionally paused between deliberate
mocked test runs. No routine runner or monitoring schedule is selected.

## Executable policy

File: financial-monitoring-local-paused-policy-2026-10-24.json.
Maximum queue snapshot age: 30000 ms.
Maximum heartbeat age: 60000 ms.
Queue review age is omitted for paused operations.
These are agreed local development values, not production recommendations.
Paused operations do not require fresh heartbeats. Source failures and
recorded runner errors can still require attention.

The policy JSON does not enforce database or environment restrictions.
Use the source-verifying local command with a separately checked identity.
Do not use this policy to declare staging or production operations paused.
Changing monitoring expectations does not disable workers, alter financial
gates or establish that scheduled charges and other financial activity stop.
Mocked tests retain their own fixture policies.

## Evidence and validation

Repository search found monitored wrappers and the daily sweep but did not
establish an automatic schedule for the ten monitored operations.
Windows scheduled tasks, running processes and external schedulers were
not inspected. Paused status records operator intent, not runtime proof.

The real assessFinancialMonitoring function accepted this policy with
supplied unavailable-source observations and did not mutate the policy.
This was a policy-validation smoke check, not a database health check or
a new automated test suite. No TypeScript or wider tests were rerun.
A repeated creation attempt refused to overwrite the existing policy.

No database access, workers, provider calls, scheduling, environment
changes, financial activation or deployment occurred during this stage.
