# HOST Stripe rehearsal and deployment readiness

Prepared: 16 October 2026
Branch: host-hotels-extension
Status: preparation only; no deployment or financial activation authorised.

## Verified evidence

- 673/673 tests passed across 21 selected financial, booking and hotel suites; no skips.
- Stripe transport was mocked. This is not real Stripe Test Mode acceptance.
- TypeScript noEmit passed after the final code/test changes.
- Refund creation locks financial and authorization evidence; request timeout is 20 seconds with SDK network retries disabled.
- Refund completion/recovery check financial snapshots and authorization, and write success plus audit transactionally.
- Audit rollback, exactly-once recording, provider-window locks and authorization-time lease expiry have targeted regression coverage.
- Hotels remain on destination_charge_legacy; new-flow rehearsal must use a suitable whole-property booking.

## Independent gates

All listed gates default OFF in source and accept only exact true. Runtime and deployed values have not been verified.
Do not enable gates as a group or change environment files as part of this preparation.

- ENABLE_DELAYED_CHARGE_BOOKINGS
- ENABLE_AUTOMATED_OFFSESSION_CHARGING
- ENABLE_HOST_TRANSFER_EXECUTION
- ENABLE_TRANSFER_REVERSAL_EXECUTION
- ENABLE_NEW_FLOW_REFUND_EXECUTION
- ENABLE_NEW_FLOW_REFUND_RECONCILIATION
- ENABLE_HOST_TRANSFER_RECONCILIATION
- ENABLE_TRANSFER_REVERSAL_RECONCILIATION
- ENABLE_NEW_FLOW_PAYMENT_RECONCILIATION
- ENABLE_CANCELLATION_HOST_SETTLEMENT_EXECUTION
- ENABLE_CANCELLATION_HOST_SETTLEMENT_RECONCILIATION
- ENABLE_MISSING_LATE_PAYMENT_REFUND_RECOVERY

## Rehearsal prerequisites - outstanding

- Establish an isolated Stripe test-mode session and test connected account; verify account identity and test mode without printing secrets.
- Independently verify the database is dedicated local host_test on loopback and the existing guard is active.
- Preserve repository changes, backups and a database recovery point before rehearsal.
- Verify schema, migration manifest, registrations and ledger for migrations 036-039 against the target rehearsal database.
- Inspect the exact runner, credentials boundary, webhook routing and allowed scenario before any real test-mode provider request.
- Scope any future gate setting to the isolated rehearsal process; leave production configuration unchanged.
- Define bounded operator invocation because new refund execution/recovery workers are not integrated into application routes or cron.
- Run each scenario separately and capture evidence before moving to the next.

## Scenario matrix - all real test-mode scenarios pending

| Scenario | Required evidence |
| --- | --- |
| Legacy hotel, two rooms | Correct quantity pricing; legacy flow; inventory release after cancellation; other bookings/closures preserved |
| New-flow successful charge | One matching PaymentIntent; one succeeded attempt; confirmation and entitlement atomic |
| Decline or authentication required | No automatic second PaymentIntent; fixed grace deadline; unresolved outcome remains protected |
| Terminal nonpayment recovery | Fresh canceled evidence with zero received/capturable amount; audited local recovery; cancellation releases inventory |
| Late payment after hold expiry | Full refund reservation with expiry authorization; booking stays cancelled; no host entitlement created |
| Full paid cancellation before transfer | Policy refund reserved once; no retained settlement; inventory released |
| Partial paid cancellation before transfer | Exact rounded guest refund; retained settlement waits for verified refund and scheduled release |
| Paid cancellation after transfer | Linked policy refund and reversal authorization; original transfer evidence verified; no duplicate movement |
| Lost response or timeout | Claim remains protected; no automatic replay; read-only provider lookup and verified recovery only |
| Concurrent/repeated invocation | One provider movement and one local completion audit; duplicate calls cannot pay/refund again |
| Audit write failure | Local success rolls back; existing provider outcome recovered without new creation |
| Changed authorization or financial evidence | Creation/recording refused; unresolved record retained for review |

## Evidence to record per scenario

- Scenario ID, booking/payment/refund/entitlement identifiers and timestamps.
- Provider account/mode and relevant provider references; exclude credentials and patient/guest personal data.
- Expected versus actual amount/currency, booking status and inventory.
- Local claim/reconciliation state, completion audit, and provider movement count.
- Pass/fail, unresolved discrepancy and next permitted action.

## Deployment readiness - not release approved

- Full source/diff review and verified cumulative archive remain outstanding.
- Production build and deployment configuration checks have not been run in this session.
- Real test-mode end-to-end acceptance remains pending.
- Reporting discovery found no direct new_flow_refunds references in app/components; trace indirect loaders, host/admin totals, guest refund wording and ledger integration before activation.
- Worker scheduling, operational review visibility and completion notifications require explicit integration review.
- Fresh-database/bootstrap migration coverage remains unverified under the agreed host_test-only scope.
- Historical missing reservations/entitlements, multiple payment attempts, legacy processing without ownership and external provider movements require separate reviewed recovery.
- New-flow dispute execution remains unsupported and blocked.
- Passing selected tests does not establish production readiness or permit live financial activation.

## Stop and recovery rules

- Any timeout, missing/duplicate/mismatched provider evidence or changed authorization stops that scenario.
- Never clear ownership or reset uncertain records to pending to force a retry.
- Gate disablement prevents future entry; it does not cancel an in-flight provider operation.
- After a provider write may have happened, inspect and reconcile existing evidence; never infer nonpayment from a local rollback or timeout.
- Preserve evidence and backups. Do not automatically undo financial records or delete test history.


## 17 October 2026 update

- Latest selected regression: 733/733 passed across 23 suites, no failures or skips; Stripe mocked. TypeScript passed.
- There are now 12 independent gates. Missing late-payment refund reservation recovery defaults OFF.
- Migration 040 serializes booking authorization-audit changes with financial booking locks. Applied and verified only on local host_test; target application remains pending.
- Target migration preparation must include 036-040, including migration 040 function/trigger verification.
- Missing late-payment refund recovery verifies one successful provider payment and unchanged local financial/expiry evidence before reserving a pending refund with an atomic audit.
- Recovery does not execute a provider refund, change booking status or authorize provider replay; it remains disconnected from API/cron.
- Existing historical inventory was inspected read-only and was not repaired in bulk.
- Confirmed-booking missing entitlements, ambiguous/multiple attempts and historical ownerless processing records still require separate review.
- Real Stripe acceptance, reporting/worker integration and deployment readiness remain outstanding.
