# Cancellation refund review wording — 31 October 2026

## Defect
After refund initiation threw, cancellation notifications still described
the refund as initiated. An isolated wrapper regression reproduced this.

## Changes
- Refund initiation errors select the needs_review notification status.
- Guest wording says initiation could not be confirmed and advises
  contacting support.
- Requested and initiated refunds retain their existing wording.
- Cancellation success and separate refund/notification errors remain.
- No refund execution, retry or reconciliation mechanism was added.

## Validation
- Wrapper runtime tests: 3 passed.
- Notification template tests: 5 passed.
- Cancellation API runtime tests: 5 passed.
- Paid and uncharged cancellation compatibility tests: 62 passed.
- Total: 75 passed.
- TypeScript and tracked whitespace checks passed.

## Limits
The refund-error wrapper case uses mocked cancellation and provider
dependencies. It does not establish the provider's actual outcome.
Compatibility tests use the local test database and provider mocks.
No real Stripe or email calls were made.
Actual delivery, operational follow-up and deployed behaviour remain
unverified. Staging release readiness remains incomplete.

## Constraints
No deployment, production migration, financial activation,
environment-file change, commit or normal Git staging change.
