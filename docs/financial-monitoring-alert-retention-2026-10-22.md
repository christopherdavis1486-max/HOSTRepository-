# In-memory financial monitoring alert retention

Prepared: 22 October 2026.

## Behaviour

The pure reducer retains active and unconfirmed monitoring conditions across
successive observations, using the existing planner and comparison rules.
Repeated unavailable evidence, explicit pause and unknown policy do not erase
earlier missing-heartbeat conditions. Reappearing retained conditions continue.
Confirming evidence clears a condition and removes it from pending state.
A later recurrence opens again. A started callback report does not clear a
retained runner-threw condition; a recent returned report can clear it.
Clearing describes a monitoring condition, not financial recovery or completion.

Retained evidence is validated against the planner. Duplicate keys, fabricated
conditions, inconsistent evidence dates and older observations are rejected.
Returned state is detached from caller inputs and previous state.

## Limits

State is caller-owned and in memory. It contains Date objects and is not a
JSON persistence format. Process restart retention is not implemented.
State retains evidence for pending conditions; it is not a complete event log
and does not preserve cleared incidents or first-seen occurrence metadata.
Caller-supplied state is validated structurally, not authenticated.
Continuing conditions do not prove a notification was delivered or acknowledged.
Delivery receipts, durable storage, reminders, routing and escalation remain
outstanding. No scheduler, notifications or financial dispatch are added.

## Validation

35 tests passed across the retention, comparison and planner files with
concurrency 1; zero failures, skips or cancellations. TypeScript passed.
This includes eleven new retention tests; counts overlap the earlier 24 tests.
An initial mutation test changed a shared fixture Date and failed ordering.
Giving each observation its own Date corrected the fixture; all 35 then passed.
Stage whitespace checked separately. Wider suites and database tests not rerun.
No tests rerun during documentation.

No migrations, persistent database changes, financial activation, deployment,
environment-file changes, commits or normal staging changes.
