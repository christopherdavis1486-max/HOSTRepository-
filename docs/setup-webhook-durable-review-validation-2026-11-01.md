# Setup webhook durable review validation - 1 November 2026

## Behaviour
Caught payment-method saving failures now attempt to persist
setup_webhook_review_required in audit_log.
The review writer locks the booking and verifies the current new-flow
booking still owns the supplied SetupIntent reference.
Duplicate and concurrent failures produce one record per booking,
SetupIntent and payment_method_save phase.
Records contain only setup identity, phase and requiresReview=true.
No raw exception details or client secrets are stored in that record.
Booking, payment attempts, deadlines and financial ownership are unchanged.

If review persistence fails, the exception propagates.
The existing webhook route returns its generic HTTP 400 error.
A later delivery can return HTTP 200 once review evidence is durable.
Acknowledgement does not establish successful setup or payment completion.

## Validation
Combined booking-route, setup, recovery, scheduled-charge and provider-lock
run: 247 passed; no failures, skips or cancellations.
TypeScript and tracked whitespace passed.
Includes sequential duplicate and concurrent failure deduplication,
injected audit-write failure, successful review-write retry and the actual
webhook HTTP route response.
The initial regression demonstrated missing durable failure evidence.
Database tests used guarded loopback host_test; Stripe/email were mocked.
No real provider or email requests were made.
The test connection interceptor preserves both pg callback and Promise use.

## Limits
This is failure evidence, not an assigned operational case or alert.
No operator UI, case assignment, resolution marker or automated retry exists.
Review history can remain after a later successful setup.
Repeated failures do not refresh the first record or count occurrences.
A changed/missing booking reference causes the writer to skip recording.
Immediate-charge refusals and api_error handling remain outside this change.
HTTP 400 behaviour is retained; deployed redelivery remains unverified.
Audit deduplication depends on writers following the booking-lock protocol.
Logging redaction and historical audit authenticity are not established.
Fresh isolated production build passed for these changes.
Cumulative review and staging acceptance remain incomplete.

## Constraints
No deployment, remote database operation, production migration, financial
activation, environment-file change, commit or normal staging change.
Backups preserved. Staging readiness has not been reached.

## Durable review build evidence
Folder: C:/Users/artem/Downloads/HOST-build-check-2026-11-01-setup-durable-review-1793572641051
BUILD_ID: VyLvEePgp-tWAmdYE0fVd
Successful exit receipt and all 788 source hashes verified.
Build used loopback host_test, twelve disabled financial gates,
no copied environment files and a non-loopback TCP guard.
Stripe values were build placeholders, not provider mocks.
Normal staging unchanged. No server started.
Operational ownership and deployed integration acceptance remain open.
