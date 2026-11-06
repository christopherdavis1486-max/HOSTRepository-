# Legacy checkout reservation validation — 1 November 2026

## Changes
- Existing reusable intents retain their reference.
- Replacement is permitted only for an explicitly canceled provider intent.
- Processing, succeeded, requires_capture and unknown statuses block replacement.
- Creation reserves a payment row and audit identity in a committed transaction
  before the provider request.
- The provider request carries the reservation metadata and idempotency key.
- An uncertain response or subsequent database-save failure retains ownership
  and blocks another creation request.
- Concurrent checkout blocks unresolved ownership or reuses the saved intent.
- Unresolved creation reservations are excluded from hold-expiry selection
  and checked again after acquiring the booking lock.
- Legacy success webhooks require one matching payment reference belonging
  to the event's booking before confirmation or financial writes.

## Validation
- Latest checkout/webhook test file: 15 passed.
- Covers uncertain creation, save failure, committed reservation identity,
  expiry refusal, unmatched references, cross-booking rejection and duplicate
  successful delivery.
- Preceding combined checkout, hotel and hold-lifecycle run: 33 passed.
- The final added matched/cross-booking/duplicate case passed in the subsequent
  15-test checkout run; no new combined total is claimed.
- TypeScript and tracked whitespace checks passed.
- Tests used the local test database, mocked provider requests and mocked
  confirmation messages. Webhook signature verification ran locally.
- No real Stripe or email requests were made.

## Lifecycle test correction
The deferred-charge fixture now starts 62 calendar days ahead, ensuring
it exceeds the 60-whole-day threshold.
Diagnostics also established 235 eligible persisted fixtures against a
200-row selector limit. The date-boundary test now scopes the actual
selector SQL to its own booking.
This verifies date eligibility, not production queue fairness.
Production scheduled-charge selection remains bounded and unordered.

## Remaining limits
- No recovery mechanism for an unsaved provider reference was added.
- An unresolved reservation can remain blocked after a crash or uncertain
  response and requires verified operational recovery.
- Metadata alone does not authorize binding a provider reference.
- Webhook changes cover matching references, not comprehensive verification
  of all legacy provider evidence.
- Expiry refusal does not establish that expired hotel inventory remains
  reserved; hotel inventory has separate hold-time rules.
- API presentation of blocked checkout and deployed webhook retry behaviour
  remain unverified.
- The latest changes have not received a fresh isolated production build.
- Cumulative source review and staging integration acceptance remain incomplete.
- Staging release readiness has not been reached.

## Constraints
No deployment, remote database operation, production migration, financial
activation, environment-file change, commit or normal Git staging change.
Source checkpoints do not back up database or Blob objects.
