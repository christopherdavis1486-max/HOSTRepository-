# Local synthetic monitoring rehearsal policy

Prepared: 22 October 2026.

This policy is exclusively for deterministic synthetic-observation tests.
All ten operations are running in the simulated scenario only. This does
not declare any real local or deployed financial runner to be running.

| Setting | Rehearsal value | Purpose |
| --- | --- | --- |
| maxSnapshotAgeMs | 30000 | Exercise snapshot freshness boundaries |
| maxHeartbeatAgeMs | 60000 | Exercise heartbeat freshness boundaries |
| dueReviewAgeMs | 30000 per operation | Synthetic queue review threshold |

No invocation cadence, scheduler or production timing requirement is selected.
Tests advance their assessment time explicitly; no timed runner is started.
The executable JSON has no environment enforcement of its own. Keep it out
of operational command invocations and do not copy its thresholds into
production policy without separate decisions.

The unknown-state decision worksheet remains unchanged and non-executable.
This stage reads no database, invokes no workers/providers, sends no messages
and does not apply migrations or modify environment files.
