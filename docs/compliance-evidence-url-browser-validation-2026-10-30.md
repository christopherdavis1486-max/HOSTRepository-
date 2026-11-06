# Compliance evidence URL browser validation — 30 October 2026

## Environment
Updated isolated production build:
C:\Users\artem\Downloads\HOST-build-check-2026-10-30-compliance

Build passed.
Local website bound to 127.0.0.1:3000.
Local limiter fixture bound to 127.0.0.1:8079.
Loopback host_test configured; all twelve financial flags disabled.
Stripe credentials were placeholders; Blob and email credentials were empty.

## Observed browser results
Property: HOST Local Publication Test 29 Oct
ID: bb9b059d-9845-41ff-a117-c3f90e3e9e76

Initial compliance status was Approved.
Entering the malformed electrical-safety evidence link and saving displayed:
items.3.evidenceUrl: electrical safety: Enter a valid HTTPS evidence link starting with https://

A subsequent valid draft save succeeded.
After reload, compliance status was In progress and the valid electrical
evidence URL was displayed.
The previous review note remained visible while the record was In progress.
Resubmission succeeded.
User then reported: Compliance approved and audited.

## Interpretation and limits
Browser rendering of the new validation error is verified.
Successful valid draft save, resubmission and simulated reapproval are verified
through supplied screenshots and user-reported confirmations.
Because a successful save occurred before persistence verification completed,
unchanged persistence following the rejected browser request was not
independently established.
Automated route tests separately verified that malformed requests do not
invoke the mocked save service.

The review note visible after approval invalidation is historical wording;
its presentation should be considered in a later UI review.
All compliance evidence and approvals are fictional local test data.
Publication remains unverified and blocked by images and Stripe readiness.
No deployment, production migration, financial activation, environment-file
change, commit or staging change was performed.
