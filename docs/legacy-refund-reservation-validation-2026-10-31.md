# Legacy refund reservation validation ? 31 October 2026

## Defect reproduced
Two concurrent service requests for 20000 and 19000 minor units against
a payment of 25500 minor units reserved more than the paid amount.
The regression failed before the fix.

## Change
The shared legacy refund service now locks the payment row and performs
payment validation, remaining-balance checking and refund-row reservation
inside one database transaction.
Pending and succeeded refunds consume the payment's refundable balance.
An unresolved matching attempt reuses its existing local refund row.
Provider lookup and refund creation occur after the reservation commits.
No migration or financial feature-gate activation was added.

Payment validation checks booking association, provider intent, currency,
eligible payment status and a positive safe-integer refund amount.

## Validation
- Refund database suite: 14 passed using local PostgreSQL and mocked Stripe.
- Isolated pagination suite: 6 passed using mocked dependencies.
- Focused hotel late-payment compatibility test: 1 passed.
- Repeated signed webhook delivery requested one mocked refund, retained
  cancellation and scheduled no payout.
- TypeScript and tracked whitespace checks passed.

## Limits
This closes the reproduced service-level balance reservation race.
It does not establish exactly-once provider execution for simultaneous
retries of one unresolved attempt or complete refund authorization.
Admin permission enforcement was inspected, not independently tested here.
The admin route's earlier balance check remains separate; the shared
service now performs the authoritative check under the payment lock.
Provider outcomes and webhook reconciliation remain separate operations.
No real Stripe refunds were issued by these tests.
The wider release review and deployed staging checks remain incomplete.

## Constraints
No deployment, production migration, financial activation, environment-file
change, commit or normal Git staging change.
Source checkpoints do not back up the local database.
