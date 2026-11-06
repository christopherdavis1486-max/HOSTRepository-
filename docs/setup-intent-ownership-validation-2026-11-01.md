# SetupIntent ownership validation ? 1 November 2026

## Findings and changes
Regression tests demonstrated that mismatched event identity and
provider customer could previously save a payment method and clear a hold.

The webhook now requires its SetupIntent ID to match the stored reference.
The confirmation helper verifies the retrieved ID, customer, booking
metadata, succeeded status, off-session usage and payment method ID.
Retrieval uses a 20-second timeout with no network retries.
Booking status, flow, customer and SetupIntent reference are rechecked
under a row lock before saving the payment method.
An unchanged payment method does not rewrite the booking or retry timestamp.
Deferred completion cannot clear an established grace period or a hold
associated with an existing payment attempt.
Deferred logging no longer incorrectly claims every hold was cleared.

## Validation
- Helper and webhook suites: 26 passed in one run.
- Hold lifecycle suite: 8 passed in a separate run.
- TypeScript and tracked whitespace passed.
- Seven ownership mismatch cases are covered.
- Three retrieval race cases cover reference change, customer change
  and cancellation during retrieval.
- Deferred duplicates preserve grace-period and existing-attempt deadlines.
- Duplicate immediate completion makes one provider creation call.
- Timeout redelivery preserves the unresolved processing attempt and
  makes no second provider creation call.
- Older fixtures now include the provider identity evidence required
  by the implementation.
- Database tests used guarded loopback host_test.
- Stripe operations and email delivery were mocked.

## Limits and remaining work
The SetupIntent creation path and client retry handling require review.
Provider retrieval failures are currently logged and acknowledged by
the webhook; durable operational recovery is not established here.
Clearing a replacement-card retry timestamp does not authorize retrying
an unresolved charge.
The final source passed a fresh isolated production build.
Cumulative release review and deployed staging acceptance remain incomplete.
Staging readiness has not been reached.

## Constraints
No deployment, remote database operation, production migration,
financial activation, environment-file change, commit or normal Git
staging change. Backups preserved.

## Creation guard follow-up
- Latest helper and webhook run: 34 passed, no failures or skips.
- Earlier separate hold lifecycle run: 8 passed.
- TypeScript and tracked whitespace passed after the final changes.
- Setup creation refuses cancelled, confirmed and refunded bookings.
- Processing and unknown SetupIntent statuses cannot authorize replacement.
- Customer and SetupIntent requests now have bounded request options.
- Conditional reference saving rejects cancellation, customer changes and
  reference changes occurring during provider work.
- The return page no longer promises automatic retry.
- The wording compiled but has not been browser-verified.
- Provider response loss before reference saving still needs durable recovery.
- Conditional saving does not prevent every duplicate non-charging provider
  resource from being created or establish recovery of orphaned resources.
- Full evidence checks for SetupIntent creation/reuse responses remain pending.
- This follow-up completes selected creation guards, not the entire creation
  path or client acceptance review.

## Isolated production build
Next.js 15.5.28 production build passed after the final source changes.
Compilation, lint and type checks, 83 static pages, tracing and
optimization completed. BUILD_ID exists.

Folder:
C:/Users/artem/Downloads/HOST-build-check-2026-11-01-setup-ownership-1793559276642

774 copied source files were hash-verified before building.
No environment files were copied. Build used loopback host_test,
all twelve financial gates disabled, no live service credentials,
and a guard against non-loopback TCP connections.
Stripe values were placeholders, not provider mocks.
Normal Git staging remained unchanged. No server was started.
The webpack cache serialization warning was non-blocking.
Browser verification, durable uncertain-resource recovery and the
remaining cumulative review are outstanding. Staging is not ready.
