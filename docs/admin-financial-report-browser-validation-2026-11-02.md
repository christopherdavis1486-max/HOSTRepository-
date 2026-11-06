# Admin financial report: local browser validation

Date: 2026-11-02
Status: Partial local browser acceptance passed. Staging readiness remains INCOMPLETE.

## Environment

- Isolated development copy served at http://localhost:3001.
- Local loopback host_test database.
- Financial activation flags disabled; placeholder Stripe configuration.
- No real email, Stripe, Redis or Blob credentials supplied to the isolated runtime.
- This session does not validate deployed production behaviour or distributed rate limiting.
- An authorized local admin password reset restored access; roles were preserved.
  Existing sessions and recovery credentials were invalidated. No email was sent.

## Observed results

- Existing booking reports loaded after admin sign-in.
- Booking 0bd54723-0967-4e7d-b003-56bccce00f8a displayed one skipped-reference
  record and the empty setup-review message.
- Booking 743d457c-11b8-449d-b714-c23ed29a8be0 displayed one Immediate charge
  follow-up record and the empty skipped-reference message.
- Switching bookings removed the preceding booking's history.
- Booking 5b941c95-aae3-4f9b-8626-754a552bac0f displayed 50 skipped-reference
  records, including the final row and explanatory text.
- Desktop and 390 x 844 browser screenshots showed readable history columns
  with wrapped record references and no visible column overlap.
- Entering invalid displayed "Enter a valid booking ID." and cleared the report.
- Entering 00000000-0000-4000-8000-000000000000 displayed
  "Booking not found." with no previous report displayed.
- The supplied console screenshot showed development information and Fast Refresh
  messages without a visible error. This was not a comprehensive console audit.

## Evidence and limits

Results were observed from user-supplied browser screenshots and report text.
The browser walkthrough did not verify provider payment state or authorize
payment retries, refunds, transfers, reference changes or reservation clearing.

The fixture bookings' Cancelled/Paid states and payout-review labels were
displayed local records; no financial conclusion is drawn from those fixtures.

The more-than-50 indicator, unknown-reason label, payment-method-save stage,
permission denial and session expiry were not separately browser-validated
in this walkthrough. Existing automated evidence remains separate.

Checkout/return and refund-label acceptance, operational incident ownership,
alerts/resolution and remaining staging integration checks are still outstanding.

## Preserved baseline

Previous verified checkpoint:
HOST-checkpoint-2026-11-01-admin-skipped-setup-history-build-235519316.zip

SHA256:
D810C6BF8F624E4DE2B833C62D803CEEBFDAAA45EE835587D94E1CC9DDFEB0D8

Previous checkpoint contained 443 source/evidence files and 445 verified ZIP files.
This documentation update does not constitute a new application build.
