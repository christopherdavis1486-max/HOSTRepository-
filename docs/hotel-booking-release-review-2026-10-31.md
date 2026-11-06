# Hotel booking release review ? 31 October 2026

## Status
Review remains in progress; staging readiness milestone not reached.

## Source reviewed
Hotel schemas, quoting, room management, booking creation, expiry,
late-payment refund handling, booking and room API routes,
migrations 034?035 and the payment-success webhook sequence.

## Findings
- Booking creation and room management share the property advisory lock.
- Hotel prices are calculated server-side.
- Hotels remain on destination_charge_legacy.
- Booking creation checks publication, compliance and expired evidence.
- Room/property association is protected by a composite foreign key.
- Cancelled hotel reservations cannot be reactivated by status updates.
- Expired pending holds are excluded from room inventory.
- The database prevents late confirmation of expired hotel holds.
- Corrected an outdated roomNights comment; query behaviour is unchanged.

## Refund recovery defect and fix
A regression test reproduced recovery attempting refund creation before
searching page two of the provider refund list.
The legacy refund service now follows pagination when recovering an
unresolved attempt.
Lookup errors, stalled/empty nonterminal pages and the 100-page search
limit abort recovery without creating another refund.
An exhausted search retains the existing local-row idempotency key.

## Validation
- New isolated pagination tests: 6 passed.
- Existing refund idempotency tests: 5 passed, using local PostgreSQL
  and mocked Stripe calls.
- TypeScript and tracked whitespace checks passed after the refund fix.
- Earlier hotel browser/payment acceptance was not repeated.

## Limits
The pagination tests mock both database and provider boundaries.
These checks do not establish deployed Stripe behaviour, concurrent
refund safety across all callers, or complete financial release readiness.
Hotel lifecycle tests were inspected but not rerun in this review stage.
The wider cumulative source review remains incomplete.
No deployment, production migration, financial activation,
environment-file change, commit or normal Git staging change.
