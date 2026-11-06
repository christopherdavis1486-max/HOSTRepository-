# Local publication walkthrough — 29–30 October 2026

## Environment
Fresh isolated Next.js 15.5.28 production build:
C:\Users\artem\Downloads\HOST-build-check-2026-10-29

Build passed compilation, lint/type validation and generation of 83 static pages.
Server bound to 127.0.0.1:3000; local limiter fixture on 127.0.0.1:8079.
Database configured as loopback host_test.
All twelve financial feature flags disabled.
Stripe credentials were placeholders; Blob and email credentials were empty.

## Automated evidence
- Image route/runtime and static regression tests: 34 passed.
- Image PostgreSQL service test: one passed using temporary tables and outer rollback.
- Joined fresh-host onboarding: three mocked cases passed — account failure,
  link failure and success with session refresh before redirect.
- TypeScript and tracked whitespace checks passed.
- Repeated outputs are not counted as additional tests.

## Browser evidence
Existing test account: host-onboarding-20261024@example.test.
User confirmed sign-in and add-property form loaded.
Created HOST Local Publication Test 29 Oct.
Property ID: bb9b059d-9845-41ff-a117-c3f90e3e9e76.
Property remained Draft.

Completed simulated compliance declarations with explicit fictional-test notes.
Initial save failed because the electrical evidence URL had a leading ": ".
Server logged property_compliance_items_evidence_url_check violation.
Correcting the field allowed the draft to save.
Submission validation then identified incomplete smoke/CO alarm information.
After correction, submission succeeded.
User reported "Compliance approved and audited."
Readiness screenshot confirmed compliance Approved and pilot review Pending.

## Publication blockers observed
- Property images: at least three images and one cover required.
- Stripe payout account: transfers not active.
- Final HOST pilot review: pending; approval blocked by other requirements.

No readiness overrides or pilot approval were performed.
Full publication and public listing visibility were not verified.

## Limits and follow-up
This browser session used an existing host account; fresh guest promotion
was covered only by the mocked joined tests.
Real Blob upload/deletion and Stripe onboarding remain unverified.
The local limiter is an in-memory fixture, not real Upstash acceptance.
JWT decryption errors appeared in the server log; their timing and cause
were not independently established in this walkthrough.
Malformed evidence URL handling should be reviewed: the observed database
constraint failure produced a generic save error instead of field validation.
Source checkpoints do not back up the local database.

## Constraints
No deployment, production migration, financial activation, environment-file
change, commit or normal staging change.
No real Stripe or email requests were intentionally submitted.
All compliance declarations and approval were simulated local test data.
