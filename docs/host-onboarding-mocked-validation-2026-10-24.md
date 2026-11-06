# Mocked host onboarding validation

Prepared: 24 October 2026.

## Validation

Latest runtime run: eleven cases passed with zero failures, skips or
cancellations. Six route cases and five service cases executed actual
source code with isolated substitutes. TypeScript passed.
The earlier five-case service run overlaps and must not be added.

Route tests use the real Zod consent schema. They cover authentication
failure, missing/false/string consents, malformed JSON, non-GB rejection,
session-owned identity, agreement-before-connect ordering, host-role
authorization and status without a host profile.

Service tests cover existing/new profiles, authoritative agreement version
and timestamp SQL, missing profiles, recipient-only account configuration,
stored account reuse and payout-capability status refresh.
Mocks do not establish real database constraints or Stripe API acceptance.

A separate eighteen-case readiness/pilot-guidance source-assertion run
passed. Those checks inspect source text; they are not runtime tests.

The initial no-index whitespace wrapper incorrectly treated Git exit code
one as a whitespace failure. A direct read-only whitespace check then
passed both new files. Stage Git whitespace is checked at close-out.

## Limits

VM harnesses replace imports and execute transformed source; they do not
exercise Next.js module loading, real sessions, HTTP middleware, database
transactions or real Stripe requests.
The account creation case checks payload and saved account data; it does
not independently assert the timing of account-link creation.
Concurrent profile/account creation and provider failure recovery are not
established by these cases.

Fresh-host browser onboarding, deployed staging verification and real
Stripe test-mode acceptance remain pending. This is not launch approval.
No application runtime code changed during this stage.
No real email, database access, provider calls, financial activation,
environment changes, migration, deployment, scheduling or commits.
No tests or production build rerun during close-out; wider suite not rerun.
