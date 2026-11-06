# Legacy refund execution validation ? 31 October 2026

## Defect reproduced
A controlled concurrent test demonstrated two callers entering provider
execution for the same unresolved refund before either completed.

## Change
The shared refund service now acquires a nonblocking PostgreSQL session
advisory lock scoped to the payment before reservation and provider work.
A competing executor receives an explicit in-progress error.
The balance-reservation transaction still commits before provider calls.
The dedicated connection is released after execution; failed unlocks
cause that connection to be discarded.

## Validation
- Refund database suite: 16 passed, with Stripe mocked.
- Isolated pagination suite: 6 passed.
- Hotel late-payment compatibility test: 1 passed.
- Admin refund authorization runtime tests: 4 passed in an earlier run.
- The authorization tests execute the actual permission helper and route
  with mocked sessions, permission rows, database and refund service.
- Provider-failure recovery was checked from a separate PostgreSQL
  connection: the execution lock was released and a later retry reused
  the same refund row and provider idempotency key.
- TypeScript and tracked whitespace checks passed.

## Deployment requirements and limits
Session advisory locking requires session affinity for the checked-out
connection. Compatibility with any staging transaction pooler must be
verified before deployment; transaction-pooled connections must not be
assumed compatible.
The lock occupies a database connection during provider work.
Tests do not establish exactly-once provider execution after connection
loss, process failure or provider idempotency retention expiry.
Deployed provider behaviour and staging connection topology remain unverified.
Cancellation access checks were inspected, not independently tested here.
The wider source review remains incomplete.

## Constraints
No deployment, migration, financial activation, environment-file change,
commit or normal Git staging change.
No real Stripe requests were made by these tests.
Staging readiness milestone remains in progress.
