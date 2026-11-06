# Payment setup operational review - 1 November 2026

## Reviewed source
- app/api/payments/setup-intent/route.ts
- app/checkout/[bookingId]/page.tsx
- app/checkout/[bookingId]/return/page.tsx
- app/api/webhooks/stripe/route.ts
- lib/payments/newFlowWebhookHandling.ts
- Internal legacy and setup reference-recovery helpers and their caller scan.

## Guest setup failure
The setup route retains SETUP_INTENT_FAILED and HTTP 400, but now returns:
"We couldn't complete payment setup. Check your trip status and contact HOST before trying again."
Raw provider/helper exception details are no longer returned by this catch.
Authentication and validation responses are unchanged.
Checkout displays the response message.
Server logging remains unchanged; log redaction was not established here.
The generic response does not identify whether a reservation exists.
It does not create an operational case or guarantee a support response.

## Uncertain creation handling
Treat provider timeout, lost response and local-save failure as uncertain.
Preserve reservation, reference, creation-audit and idempotency history.
Do not reset ownership, delete audits, create another resource or infer
that the provider did nothing from an absent local reference.
Check committed booking/payment state and the exact payment-flow version.
Record the investigation, evidence, responsible operator and next action
in an approved durable case system before attempting recovery.
No case system or responsible operator has been assigned by this change.

Both reference-recovery helpers remain internal and disabled by default.
They require explicit verified identity and test-mode evidence.
They retain unresolved ownership and do not complete the payment lifecycle.
Setup recovery currently excludes lost Customer responses, replacements,
cancelled/archived bookings, saved payment methods and payment attempts.
It does not authorize creating, confirming, canceling or charging resources.
There is no configured operator command or reservation-release workflow.

## Setup webhook acknowledgement
The setup-success handler catches payment-method persistence failures,
logs them and returns. This includes provider retrieval or database errors
raised inside that helper, as well as deliberate ownership refusals.
The outer webhook route therefore can acknowledge a delivery despite
payment-method saving not completing.
Immediate charge refusals and api_error outcomes are also logged.
An acknowledgement does not establish setup or payment completion.

Do not rely on automatic redelivery to resolve these caught failures.
Investigate the booking, reservation, provider evidence and payment attempts
before a targeted recovery. A missing method or pending booking does not
prove the card was not charged.
Transient-error classification, durable follow-up, alert routing and safe
redelivery/reconciliation handling remain unresolved readiness findings.
The webhook HTTP response behaviour was reviewed in source, not newly
verified through deployed delivery or route-level failure simulation.

## Return-page limits
The page polls booking data rather than trusting redirect status.
A pending-booking timeout advises checking trip status and contacting HOST.
Failure states show review wording and retain an update-payment link.
Network errors are swallowed by polling; absent booking data can leave
the confirming display after polling stops.
Browser acceptance and the unresolved-state presentation remain open.

## Validation
Booking route integration suite: 8 passed with mocked Stripe and email.
The new regression first reproduced raw error exposure.
It verifies one provider creation, retained unresolved ownership, no saved
reference, no client secret and safe guidance across a second request.
Success fixtures now supply required provider evidence; repeat-call tests
assert successful responses and reuse of the same client secret.
TypeScript and tracked whitespace passed.
Earlier 235-test setup/recovery/charge run is separate, not a new combined run.
Fresh isolated production build passed for the route change.

## Constraints
No deployment, remote database operation, production migration, financial
activation, environment-file change, commit or normal staging change.
Backups preserved. Staging readiness remains incomplete.

## Route guidance build evidence
Folder: C:/Users/artem/Downloads/HOST-build-check-2026-11-01-setup-route-guidance-1793570907861
BUILD_ID: B9Gw4y9kLOxDKz-kjiAjd
Successful exit receipt and all 786 source hashes verified.
Build used loopback host_test, twelve disabled financial gates,
no copied environment files and a non-loopback TCP guard.
Stripe values were build placeholders, not provider mocks.
Normal staging unchanged. No server started.
Browser and deployed integration acceptance remain outstanding.

## Durable setup-save failure review follow-up
The earlier finding of log-only payment-method saving failures is partially
addressed: matching current setup references now receive durable audit
review evidence before acknowledgement. Review-write failures propagate.
Combined validation: 247 passed; TypeScript and whitespace passed.
See setup-webhook-durable-review-validation-2026-11-01.md.
Assignment, alerts, resolution tracking, skipped stale references and
immediate-charge failure handling remain open.
Fresh isolated production build passed; checkpoint preparation follows.

## Durable review build evidence
Folder: C:/Users/artem/Downloads/HOST-build-check-2026-11-01-setup-durable-review-1793572641051
BUILD_ID: VyLvEePgp-tWAmdYE0fVd
Successful exit receipt and all 788 source hashes verified.
Build used loopback host_test, twelve disabled financial gates,
no copied environment files and a non-loopback TCP guard.
Stripe values were build placeholders, not provider mocks.
Normal staging unchanged. No server started.
Operational ownership and deployed integration acceptance remain open.
