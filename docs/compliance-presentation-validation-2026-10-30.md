# Compliance presentation validation — 30 October 2026

## Changes
- Compliance PUT validation responses include issue paths and messages.
- Evidence URL errors appear alongside the affected field, with aria-invalid
  and aria-describedby linking the input to its explanation.
- A validation summary replaces raw API paths for mapped evidence errors.
- Previous review notes are labelled historical when status is neither
  approved nor changes_required.
- Successful saves clear outdated item review labels in client state.
- Network and unreadable-response failures release the save buttons and
  advise reloading to check status before retrying.

## Verification
13 compliance tests passed, including real route loading with mocked access
and persistence, structured issue paths/messages, and rejection before saving.
Five mounted React/jsdom scenarios passed; Node reports six including parent:
- Inline evidence error and accessible association without raw API paths.
- Successful save labels historical review and clears item approvals.
- Loaded submitted record labels its previous review.
- Network failure releases buttons and advises checking status.
- Unreadable JSON response does likewise.
TypeScript and tracked whitespace checks passed.

## Limits
React tests use mocked fetch, navigation and translation adapters.
No real database or provider operations are exercised by the mounted tests.
Updated presentation has not yet been rebuilt or visually checked in a browser.
Backend approval and publication rules are unchanged.
Backups and normal Git staging preserved.
No deployment, migration, financial activation, environment-file changes,
commits or real Stripe/email requests.
