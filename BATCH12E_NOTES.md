# HOST Batch 12E — Multilingual host and admin journeys

## Included

- Six-language host dashboard, bookings, booking detail and payout presentation.
- Locale-aware host dates, booking/payment statuses and currency formatting.
- Six-language property list, creation, editing, availability and listing controls.
- Six-language reviews, public replies and shared guest/host messaging controls.
- Six-language Stripe Connect onboarding and payout-status screens.
- Six-language host compliance workflow and admin compliance/security actions.
- Host/admin language selectors continue to use the persisted HOST locale.

## Translation boundary

Operational headings, labels, buttons, states and validation guidance are translated.
Authoritative legal, compliance-liability and privileged-security explanations remain in
English so their meaning is not altered by an informal interface translation. Backend
error messages are also shown verbatim when supplied by the API.

## Verification

- Host localisation unit tests.
- TypeScript `--noEmit` check.
- Next.js production build.
