# SetupIntent response evidence validation ? 1 November 2026

## Changes
Creation and reuse now validate SetupIntent object type, ID format,
customer identity, booking metadata, off-session usage and supported status.
Existing references must match the retrieved provider ID.
Reusable client secrets must belong to the exact returned SetupIntent.
Terminal identity is validated before replacement is permitted.
Deleted expanded customer references are rejected.

## Validation
Combined latest run: 64 passed with no failures, skips or cancellations.
Coverage comprises 22 helper database tests, 20 webhook database tests
and 22 pure evidence tests.
Eight database regressions first demonstrated acceptance of mismatched
creation, reuse and terminal-replacement evidence.
Valid creation, reuse and replacement fixtures now contain complete evidence.
TypeScript and tracked whitespace passed.
Tests used guarded loopback host_test with mocked Stripe and email.

## Limits and next work
This validates received responses, not missing provider outcomes.
No durable SetupIntent creation reservation or recovery was added here.
Provider resource creation may succeed before a response or local save fails.
Provider mode and newly created Customer-object metadata are not validated
by this SetupIntent evidence helper.
This source has not yet received a fresh isolated build or checkpoint.
Cumulative release review and staging acceptance remain incomplete.

## Constraints
No deployment, remote database operation, production migration,
financial activation, environment-file change, commit or normal staging
change. Backups preserved.
