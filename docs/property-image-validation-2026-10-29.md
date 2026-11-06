# Property image validation — 29 October 2026

## Changes
- Require a property directory boundary and a non-empty filename during upload token generation, registration confirmation, callback processing and shared-service registration.
- Validate the requested pathname supplied to the Blob SDK callback.
- Remove the ineffective returned pathname option.
- Restrict registration URLs to public HTTPS Vercel Blob URLs.
- Reject other domains, credentials, explicit ports, query strings and fragments.

## Verified results
- 34 route/runtime and static regression tests passed.
- One PostgreSQL integration test passed against guarded local host_test.
- TypeScript passed after both validation and database-test changes.
- Tracked whitespace checks passed after the validation changes.

## Database coverage
Actual propertyImages.ts service SQL ran against temporary PostgreSQL tables.
Verified registration, duplicate registration, ownership rejection, invalid path
and URL rejection before transaction access, cover selection, alternative text,
ordering, invalid-order rejection, deletion and replacement cover selection.
The outer transaction rolled back and removal of the temporary image table
was confirmed.

## Limits
Database transaction handling was adapted to savepoints inside an outer
rollback-only transaction. This does not verify commits, concurrent requests,
the complete application schema, or browser-to-database integration.
Blob operations were mocked; real Blob upload and deletion remain unverified.

## Preservation
Original edited files were backed up before changes.
No deployment, production migration, financial activation, environment-file
change, commit, staging change, real email or Stripe request was performed.
