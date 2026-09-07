# Batch 10B — Trip clarity, incomplete-booking UX and presentation polish

## Changes

- My Trips now derives the same authoritative new-flow payment state used by Trip Detail.
- Long-lead bookings display **Payment scheduled** instead of the misleading “payment not completed”.
- Incomplete bookings remain visible and provide a clear **Resume payment** or **Review payment** action.
- Grace-period failures are visually highlighted without changing booking or payment records.
- Added explicit labels for scheduled, payment-method-required, grace-period and failed payment states.
- Currency values now use stable tabular numerals and the body font to prevent the previously observed overlapping/duplicated amount rendering.
- Improved keyboard focus indicators, loading announcements and small-screen layouts.

## Safety boundaries

- No bookings or financial records are deleted, hidden or rewritten.
- No migrations were added or changed.
- No Stripe charging, retry, webhook, refund, tax, transfer or entitlement logic was changed.

## Verification

- Focused presentation and trip-grouping tests: 21/21 passed.
- `npx tsc --noEmit`: passed.
- `npm run build`: passed (40/40 static pages).
