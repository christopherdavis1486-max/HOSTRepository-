# Legacy checkout and unpaid discard validation — 1 November 2026

## Reproduced defects
- A legacy booking with an unresolved pending payment could be discarded.
- Discard could complete while legacy payment-intent creation was in flight,
  before its payment record was persisted.
Both local-database regressions failed before their respective fixes.

## Changes
- Any existing legacy payment record blocks unpaid discard.
- Legacy payment-intent creation uses one transaction and locks the booking
  row through provider retrieval/creation and payment-record persistence.
- Discard refreshes legacy payment existence after acquiring the booking lock.
- Provider retrieval and creation use a 20-second request timeout with
  automatic network retries disabled.
- Database lock, statement and idle-transaction timeouts are configured.

## Validation
- Booking access and discard tests: 14 passed.
- Payment-intent concurrency and existing-intent reuse tests: 2 passed.
- Hotel lifecycle compatibility tests: 11 passed.
- Total across these files: 27 passed.
- TypeScript and tracked whitespace checks passed.
- Provider requests were mocked; database fixtures were local.

## Scope and remaining findings
- The concurrency regression exercises payment creation winning ownership,
  followed by discard waiting and refusing after payment persistence.
- The reverse ordering and simultaneous checkout requests need coverage.
- Holding a transaction during provider work consumes a database connection.
- The change does not solve provider success followed by database failure,
  process interruption or uncertain request outcomes.
- Provider creation still lacks a durable idempotency/recovery design.
- Existing processing or succeeded intents can fall through to replacement
  creation when the local payment is not marked paid. This remains an open
  financial-safety finding requiring regression coverage and correction.
- Other returned provider statuses also need explicit disposition.
- Existing intent evidence validation and late non-hotel payment recovery
  remain outside the completed scope.
- The hotel suite passed, but does not establish complete legacy checkout
  compatibility or real provider behaviour.
- No fresh isolated production build includes these changes yet.
- Cumulative source review and staging release readiness remain incomplete.

## Constraints
No deployment, remote database operation, production migration,
financial activation, environment-file change, commit or normal Git staging change.
