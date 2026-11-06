# Legacy intent reference recovery validation — 1 November 2026

## Scope
Internal reference-recovery helper and evidence validation.
No API route, scheduler or operator command invokes the helper.
It is disabled unless its caller explicitly supplies an enabled callback.

## Behaviour
- Requires explicit booking, payment, creation-audit and provider-intent IDs.
- Locks the booking, payment, price, host profile and reservation audit records.
- Requires the current local details to match the committed reservation.
- Refuses missing, changed or ambiguous reservation evidence.
- Retrieves the supplied existing intent with bounded request options.
- Requires test-mode evidence matching reservation metadata, amount,
  currency, application fee, destination and supported status.
- Rejects manual capture, unexpected received/capturable amounts,
  transfer amount overrides and on_behalf_of.
- Rechecks enablement after retrieval before recording.
- Saves the reference and recovery audit in one transaction.
- Retains processing status and the unresolved creation-reservation marker.
- Repeated recovery of the same reference adds no further audit.
- Makes no provider create, confirm, cancel, refund or transfer request.
- Does not change booking status, inventory, ledger entries or payouts.

## Validation
- Checkout/webhook/recovery database test file: 30 passed.
- Pure recovery evidence test file: 26 passed.
- Combined latest run: 56 passed; no failures, skips or cancellations.
- Includes successful reference recording for six supported provider statuses,
  mismatched evidence rejection, default-disabled behaviour, gate shutdown
  during retrieval and retrieval failure.
- Audit insertion failure rolls back the reference update.
- Concurrent recovery records one reference and one completion audit.
- TypeScript and tracked whitespace checks passed.
- Database fixtures used local host_test; provider requests and confirmation
  messages were mocked. No real Stripe or email requests were made.

## Limits and remaining work
- This recovers a reference, not the complete payment lifecycle.
- It does not discover a missing provider ID or prove that no intent exists.
- It never authorizes another creation request.
- Retained reservations still block checkout, including canceled intents,
  until an appropriate verified completion or release process exists.
- Booking confirmation and late-hotel handling remain separate webhook paths.
- Deployed authorization, operator ownership, retry behaviour and recovery
  presentation remain unverified.
- No comprehensive test of recovered references through every subsequent
  webhook and expiry path has been completed.
- Reservation histories containing multiple creation audits are refused.
- The gate is a caller-supplied callback, not a configured operational control.
- Gate checks cannot cancel an already-issued retrieval request.
- The latest source has not received a fresh isolated production build.
- Cumulative review and staging integration acceptance remain incomplete.
- Staging release readiness has not been reached.

## Constraints
No deployment, remote database operation, production migration, financial
activation, environment-file change, commit or normal Git staging change.
Source checkpoints do not back up database or Blob objects.
