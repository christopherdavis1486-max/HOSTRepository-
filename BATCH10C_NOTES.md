# Batch 10C — Branded checkout, truthful charge timing and customer navigation

## Changes

- Restyled Stripe checkout with HOST's dark editorial design and Stripe's night appearance.
- Checkout wording now uses the booking's persisted `scheduledChargeDate`:
  - a future date says the card is saved and charged later;
  - a due/past date says the card is charged immediately after confirmation.
- Immediate new-flow checkout uses **Save card and pay** instead of the misleading **Save payment method**.
- Return pages now show a specific declined-payment state immediately, including the genuine retry time and actions.
- Added consistent customer navigation to Search, Stay Detail, My Trips, Account, Checkout and Checkout Return.
- Test-card instructions only render when the publishable key is a Stripe test key.
- Staging badge and GitHub controls now require `NEXT_PUBLIC_SHOW_STAGING_UI=true`; they are absent by default.
- Standardized **Browse destinations** wording and responsive/keyboard-focus presentation.

## Safety boundaries

- No Stripe confirmation calls, webhook logic, retries, transfers, refunds or database migrations were changed.
- Charge timing affects wording only; the server remains the authority for whether and when a charge occurs.

## Verification

- Focused presentation tests: 24/24 passed.
- `npx tsc --noEmit`: passed.
- `npm run build`: passed (40/40 static pages).
