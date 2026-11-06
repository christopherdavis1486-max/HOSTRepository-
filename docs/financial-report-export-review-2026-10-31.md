# Financial report and export review — 31 October 2026

## Reviewed source
- Admin financial report route and report helper.
- Account data-export route.
- Guest booking and host financial export helpers.

## Findings
- Admin reporting requires bookings, refunds and payouts read permissions.
- Invalid booking identifiers are rejected before report retrieval.
- Admin report responses, including errors, use private, no-store.
- Guest financial exports filter bookings by the session user's ID.
- Host financial exports filter through the session user's host profile.
- Financial export queries select explicit fields, excluding provider
  references and execution tokens.
- Account exports derive identity from the session.
- Internal failures receive generic external error messages.
- Admin report reads are separate and may reflect concurrent changes;
  the response explicitly discloses that limitation.

## Correction
Account-export error responses now include Cache-Control: private, no-store.
Assertions cover unauthenticated, guest-export failure and host-export
failure responses.

## Validation
- Five reporting/export test files: 34 passed.
- Zero failures, skips or cancellations.
- TypeScript and tracked whitespace checks passed.
- Database tests used local fixtures; provider dependencies were mocked.
- No refunds or payouts were executed.

## Limits
This review covers the listed reporting/export source, not all account
privacy functions or all financial code.
Deployed authorization, download behaviour and operational auditing remain
unverified.
Export reads are not a single consistent database snapshot.
The cache-header correction is newer than the final isolated build.
Staging release readiness remains incomplete.

## Constraints
No deployment, production migration, financial activation,
environment-file change, commit or normal Git staging change.
