# HOST Batch 13B Staging Acceptance

Date: 11 September 2026
Production: https://www.hostcityliving.com
Fix commit: 9eb5abe
Deployment: https://host-jehaa9uk8-host-team1.vercel.app

## Result

Batch 13B staging acceptance passed.

## Verified flows

- Guest registration, email verification, sign-in, profile, and notification preferences.
- Favourite save and removal persistence.
- Paid Stripe test booking for 20-22 October 2026.
- Booking reference: a98be907-c5a4-4e52-9ded-8b664d639876.
- Payment confirmed: GBP 234.00.
- Guest-to-host and host-to-guest messaging.
- Cancellation and full Stripe webhook refund.
- Booking, message, cancellation, and refund-completed emails.
- Refunded booking archived from My Trips.
- Abandoned unpaid booking discarded from My Trips.
- Refunded booking cannot re-enter checkout.
- Cancelled booking cannot be reviewed.
- Archived booking record remains directly accessible to its guest.
- Batch 11 Compliance Acceptance returned to Paused.
- Batch 11 Partial Draft Regression remains Draft and non-public.

## Access-control acceptance

- Signed-out users cannot access account, trips, favourites, booking details, messages, or host property management.
- Guest-only accounts cannot access host dashboard, bookings, properties, reviews, or host APIs.
- Guest-only accounts cannot access admin compliance or security data.
- Another host's property and compliance data remain inaccessible.
- Compliance API fails closed with a permission error.

## Defects fixed and retested

- Message emails now include the property name instead of "undefined".
- Saved stays link added to signed-in customer navigation.
- Host workspace link added for host-role accounts only.
- Unauthorised compliance pages no longer expose the form shell or action buttons.
- Archived trips no longer show a duplicate archive action.
- Cancelled bookings show accurate review-ineligibility copy.
- Invalid checkout states use the HOST dark interface.

## Verification

- Focused messaging route suite: 7/7 passed.
- Production build: passed compilation, linting, type checking, and 61/61 static pages.
- Full suite: 364/451 passed; 87 migration/database tests could not run because local PostgreSQL at 127.0.0.1:5432 was unavailable.
- Production deployment completed and all Batch 13B fixes were manually retested.

## Safeguards retained

- Stripe remains in test mode.
- Delayed charging remains disabled.
- Automated off-session charging remains disabled.
- Host-transfer execution remains disabled.
- Stripe Funds Segregation remains under review.
