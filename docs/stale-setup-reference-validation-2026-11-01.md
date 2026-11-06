# Historical stale setup reference validation - 1 November 2026

## Behaviour
Historically linked setup_intent.succeeded deliveries whose reference is
no longer current can record setup_webhook_reference_skipped in audit_log.
This is delivery evidence, not current ownership or a resolved operational case.

The writer requires a matching reservation/completion link for the same
booking, SetupIntent, customer and creation identifier. Event metadata
alone is insufficient. Current references and unlinked history are excluded.
The event must identify a succeeded off-session SetupIntent.

Booking locking serializes duplicate writers. Records contain only the
historical SetupIntent identifier and historical_reference_not_current reason.
The writer does not change booking state, methods, attempts, deadlines,
reservations or financial authority, and makes no provider calls.

The handler records eligible skipped deliveries both at the initial
reference mismatch and after payment-method saving fails during a
reference-change race. Existing current-reference review checks remain.

Audit-write failures propagate. The webhook route returns its safe
HTTP 400 response until evidence can be written; subsequent deliveries
can return HTTP 200 and deduplicate the record.

## Validation
Full setupIntentWebhookFlow suite: 42 passed.
Zero failures, skips or cancellations.
TypeScript and tracked whitespace checks passed.
Stripe/email mocked; guarded local work used loopback host_test.

New tests cover historical stale delivery, sequential deduplication,
concurrent writers, absent completion history, wrong customer, wrong
creation ID, other-booking history, current-reference exclusion,
reference changes during retrieval, and route audit failure/redelivery.
Initial regressions reproduced missing initial and retrieval-race evidence.
An explicit text cast corrected a PostgreSQL JSON-text/UUID comparison.

## Limits
Only linked creation-completion history is supported in this change.
Recovery-only references, older records without creation metadata,
missing bookings and unrelated references do not receive this record.
Historical audit authenticity is not established by these checks.
Skipped delivery does not automatically mean an incident requires action.
No case assignment, alert, resolution marker or retry authority is added.
The separate skipped-reference action is not shown in the admin report.
Browser and deployed delivery acceptance remain outstanding.
Fresh isolated build and checkpoint remain pending.
Staging readiness remains incomplete.

## Constraints
No deployment, remote database operation, production migration, financial
activation, environment-file change, commit or normal Git staging change.
Backups preserved. No server started.


## Stale setup reference isolated build evidence
Folder: C:/Users/artem/Downloads/HOST-build-check-2026-11-01-stale-setup-reference-1793576539530
BUILD_ID: 8K2uTGPCwT9CQPjQqSGBn
Completed: 2026-11-01T23:42:45.298Z
Successful receipt; all 792 source hashes verified.
Twelve financial gates disabled; no environment files copied.
Non-loopback TCP blocked; Stripe build placeholders used.
Git staging unchanged. No server started.
Setup webhook suite: 42 passed; TypeScript and whitespace passed.
This supersedes this section's earlier pending-build statement.
Checkpoint folder: C:/Users/artem/Downloads/HOST-checkpoint-2026-11-01-stale-setup-reference-build
ZIP creation and archive verification remain pending.
Recovery-only/unlinked references, admin visibility, ownership, alerts,
resolution tracking and browser/deployed acceptance remain open.
Staging readiness remains incomplete.
