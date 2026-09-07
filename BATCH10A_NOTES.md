# Batch 10A — Account navigation and payment recovery UX

## Changes

- Added session-aware homepage navigation:
  - signed out: **Log in** and **Sign up**
  - signed in: **My trips**, **Account**, and **Log out**
- Added direct registration mode at `/login?mode=register`.
- Added a guest payment-recovery panel for bookings in `payment_grace_period`.
- The recovery panel displays the real latest failure message, automatic retry time, and grace-period expiry returned by the authenticated booking API.
- Added an **Update payment method** action using the existing protected checkout flow.
- Renamed **Discover stays** to **Browse destinations** on My Trips.

## Safety boundaries

- No migrations were added or changed.
- No charging, retry, webhook, refund, transfer, tax, or entitlement logic was changed.
- Stripe identifiers and payment-method details are not added to the booking response.
- Recovery data remains behind the existing booking ownership check.

## Verification

- `npx tsc --noEmit`: passed.
- `npm run build`: passed (40/40 static pages).
- The full database-backed test suite was not run in the packaging environment because the private `.env.local` file is intentionally excluded. Run `npm.cmd test` locally after copying the verified `.env.local` into the extracted project.
