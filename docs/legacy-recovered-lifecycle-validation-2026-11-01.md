# Legacy recovered payment lifecycle validation ? 1 November 2026

## Finding and correction
A failed-payment webhook previously overwrote the unresolved creation
reservation marker. It could also downgrade a paid payment.
Failure updates now require a matching booking and Stripe payment,
an eligible unpaid status, and no unresolved creation reservation.
Failure notifications run only after an accepted update.

## Validation
- Checkout, webhook and recovery database tests: 39 passed.
- Pure recovery evidence tests: 26 passed.
- Combined latest run: 65 passed with no failures, skips or cancellations.
- TypeScript and tracked whitespace checks passed.
- Regression first demonstrated the reservation-marker overwrite.
- Coverage includes recovered success, duplicate success, preserved
  ownership after failure, stale failure after success, and failure
  followed by success after the whole-property hold deadline.
- Recovered hotel coverage expires the original hold, books its room
  again, and delivers late success with duplicate and stale-failure events.
- Original hotel booking remains cancelled with the late-payment flag.
- Replacement booking and its room inventory remain unchanged.
- No payout is scheduled for the late hotel payment.
- Exactly one pending refund with a provider reference is recorded.
- Stripe creation, retrieval and refund calls were mocked.
- Confirmation messages and failure notifications were mocked.
- Database tests used guarded local loopback host_test.

## Limits and next work
- Refund submission is tested; refund completion is not established here.
- An unresolved hotel payment reservation does not retain room inventory
  after its hold deadline.
- Recovery remains an internal explicitly enabled test-mode helper.
- Recovery does not authorize another intent creation.
- Reservation markers are retained; no release process was added.
- Ordinary unpaid failure, cross-booking rejection and stale failures against
  paid and refunded states passed focused compatibility tests.
- Five broader webhook suites passed 38 tests with mocked email and blocked
  Stripe network methods. Notification records remained real in those suites.
- These were separate runs of 65 and 38 tests, not one combined run.
- Failure-notification delivery counts and comprehensive concurrent event
  ordering remain outside the focused compatibility tests.
- Comprehensive legacy success evidence validation remains outside
  these tests.
- Fresh isolated build passed; staging integration acceptance remains pending.
- See isolated-build-recovered-lifecycle-validation-2026-11-01.md.
- Staging readiness remains incomplete.

## Constraints
No deployment, remote database operation, production migration,
financial activation, environment-file change, commit or normal Git
staging change. Existing backups were preserved.
