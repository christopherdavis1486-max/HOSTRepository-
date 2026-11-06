# Local pilot validation - 24 October 2026

Status: local validation checkpoint; not release or real-host onboarding approval.

## Monitoring email

Immutable occurrence storage and committed-chain replay implemented.
Replay requires supplied observations for every record; the first record hash
is the chain identifier. Existing chains without observations cannot be fully
replayed by this verifier. Stop writers throughout verification and attempts.
Trusted local storage is assumed; hashes are not authentication or rollback protection.

Injected attempts persist intent before sender invocation and store accepted,
rejected or uncertain outcomes. Existing intents block automatic resend.
Verified workflow permits latest-record warning openings and clearing only
after matching opening acceptance for the same occurrence and recipient.
No catch-up delivery, reminders, provider integration or operational CLI.
Provider acceptance is not inbox delivery. Real email remains disabled.

Focused runs passed: storage/codec 9; replay/storage 7; attempt/adapter 8;
verified/stored workflow 6; latest failure/workflow run 8.
Counts overlap and must not be added. TypeScript passed.
Latest failure cases cover outcome-file open failure after mock acceptance
and process.exit during a mocked send; fresh processes refuse resend.
They do not establish arbitrary-kill or power-loss durability.

## Staging configuration

Existing staging preflight returned 0 errors and 0 warnings.
File inventory showed three financial gates explicitly false and nine unset.
Source confirms all twelve accept exact true only; unset defaults off.
Local/test files have delayed booking and automated charging flags true.
Files were unchanged; the UI server/build used process overrides setting all
twelve gates false and a loopback host_test database URL.
No deployed staging values, database identity or provider connectivity verified.
Staging runner ownership, schedules and operational monitoring policy remain undecided.

## Local browser review

Add-property form loads with Hotel and Aparthotel, policies and amenities.
Existing hotel room management shows Standard Double: 3 rooms, 2 guests,
100/night; Deluxe Twin: 2 rooms, 2 guests, 150/night.
Combined room fixture remains paused and was absent from shown public cards.
Host inventory for 4-6 December shows 3 Standard Double rooms each night,
zero reserved and 100/night; exclusive end date behaves as expected.
Compliance approval explicitly identifies fictional local fixtures.
Readiness reports all requirements complete; publication status shows Published.
Hotel appears in Liverpool results; public room cards and prices display.
For 4-7 December, 2 rooms/4 guests preview 600 Standard Double or 900 Deluxe Twin;
cleaning and taxes show zero. These are previews, not checkout totals.
Operator confirmed room quantity capped at 3 and one-room guest count capped at 2.
No new reservation, payment, paid cancellation or Stripe onboarding submitted.

## Onboarding wording

Draft note now requires listing completion, compliance and HOST pilot approval.
Stripe completion text distinguishes account setup from publication and payouts.
Originals backed up. Draft note visually confirmed; Stripe completion checked
from source only. TypeScript and tracked whitespace checks passed.
Garbled PowerShell characters were not reproduced in inspected browser labels.

## Backend and build

All 11 hotel lifecycle tests passed against local host_test.
Coverage includes oversell concurrency, quantity pricing, cancellation, expiry,
immutable room snapshots, ownership and mocked late-payment refund handling.
Tests retain generated fixtures; no cleanup of historical test data was performed.
Local production build passed compilation, lint/type checks and 83 static pages.
Build used dummy Stripe credentials and disabled email credentials; no deployment.

## Remaining pilot blockers

- Real Stripe test-mode onboarding, checkout/webhooks/refund acceptance not run today.
- New host/property creation and approval journey not exercised end to end today.
- Deployed staging configuration, schema and provider readiness not independently verified.
- Operational runner schedules, ownership, monitoring policy and deployment storage undecided.
- No live email integration, mailbox verification or delivery activation.
- Full-project regression, fresh database bootstrap and full release diff review not completed.

Existing financial activation and no-deployment restrictions remain in force.
No environment-file changes, production migrations or commits.
