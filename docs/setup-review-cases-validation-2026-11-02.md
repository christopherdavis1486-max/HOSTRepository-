# Setup investigation case tracking validation

Date: 2026-11-02
Status: Local automated acceptance passed; build and browser acceptance pending.
Staging readiness remains INCOMPLETE.

## Behaviour
Migration 048 adds setup_review_cases linked to original audit evidence.
It is registered in the runner, generator and captured schema manifest.
The public application table has not been permanently applied in this work.

The service supports claim/reassignment, owner-only resolution and reopening.
Updates require a matching expected version and serialize on the source audit.
Case changes and their audit entry share one transaction.
The service rechecks active admin access, verified email, a stored passkey and
reconciliation write permission (or super_admin).
Client-supplied actor fields are rejected; the route supplies the session actor.
Resolution codes describe investigation outcomes, not verified payment outcomes.

GET and PATCH endpoints require secure admin access and appropriate reconciliation
permissions. PATCH additionally requires an Origin matching the request URL.
The reader returns the newest 50 eligible records, hasMore and restricted fields.
Untracked evidence is displayed as unclaimed with version zero.
This is booking-specific access; it is not a global operational alert queue.

The financial-report page includes a separate panel with explicit loading,
required notes and reload after each attempted mutation.
Lost responses do not trigger an automatic mutation retry.
Failed refresh removes stale mutation forms.
Closing a case does not change payment state, release reservations or authorize recovery.

## Validation
Combined selected run: 101 reported tests passed, zero failures or skips.
Includes service/read, concurrency, route, React/jsdom panel, schema,
existing financial-report and setup-webhook suites.
The schema test includes 16 checks within one reported test.
TypeScript and whitespace passed.
Route and panel tests use mocked dependencies and do not establish deployed behaviour.
Service lifecycle tests use real PostgreSQL in a rollback-only transaction.
Separate-connection races use a unique disposable local schema, removed afterward.
Competing claims and resolutions each produced one winner and one version conflict.
Tests verified atomic rollback on audit failure and original evidence preservation.

## Limits and remaining work
Fresh isolated production build and checkpoint pending.
Browser operation, deployed authentication and proxy/origin behaviour unverified.
Alerts, named operational responsibility, escalation and response procedures remain open.
Older-than-50 navigation, recovery-only/unlinked evidence and comprehensive
cumulative source review remain open.
The prior hydration warning and checkout/provider integration gaps remain open.
No deployed integration acceptance is claimed.

## Boundaries
Loopback host_test only. No deployment, remote database operation, production
migration, financial activation, environment-file change, commit or Git staging change.
Existing application financial records were not changed by the case tests.
Backups preserved.


## Setup review cases isolated build evidence
Folder: C:/Users/artem/Downloads/HOST-build-check-2026-11-02-setup-review-cases-1793657199442
BUILD_ID: GAhRaB0OgAkN7e9UfJLqd
Completed: 2026-11-02T22:07:08.276Z
Successful isolated production build; 805 input files verified before build.
Compilation, type checks and generation of 83 static pages completed.
Twelve financial flags disabled; no environment files copied.
Network guard preload passed. Git staging unchanged.
No migration applied or server started.
This supersedes the earlier pending-build statement for this change.
Combined selected validation: 101 passed; TypeScript and whitespace passed.
Browser acceptance and checkpoint archive remain pending.
Alerts, named operational responsibility, escalation, recovery-only/unlinked
evidence and deployed acceptance remain open.
Staging readiness remains INCOMPLETE.


## Setup review cases local browser acceptance
Date: 2026-11-02
Local migrations 047 and 048 were applied together to loopback host_test.
Each introduced schema was compared with its registered manifest before commit.
Both tables and ledger entries had been absent before application.
No financial execution flags were enabled.

An isolated development browser server was started on localhost:3001 from the
805-file reviewed source set, with placeholder Stripe values, no copied env files,
a non-loopback TCP guard and twelve disabled financial flags.
This is development-server acceptance, separate from the successful production build.

Booking: 92b8f294-4662-49de-956a-6dd89386d891
Review evidence: 55f6fd90-ea08-4c3c-8aa1-048eda7f165d
The panel loaded Immediate charge follow-up as unclaimed, version 0, unassigned.
Save was disabled with an empty note.
Browser claim saved as in_review version 1 with the acting administrator assigned.
Browser resolution saved as resolved version 2 with code, note and timestamp.
Browser reopening saved as in_review version 3 and cleared current resolution fields.
The final database lookup verified version 3, null resolution fields and exactly
the claim/version 1, resolve/version 2 and reopen/version 3 audit sequence.
The synthetic fixture remains in_review.

Screenshots: Screenshot 2026-11-02 225733.png,
Screenshot 2026-11-02 230101.png and Screenshot 2026-11-02 230312.png.
Claim confirmation was also supplied as pasted page text.
The display shows a question-mark separator between status and version;
presentation cleanup remains open.

This supersedes earlier statements that these migrations were not locally applied
and that this claim/resolve/reopen browser path was pending.
Browser denial, conflict, lost-response and mobile cases were not exercised here;
their existing automated checks are separate evidence.
No provider action or financial recovery was exercised.
Database-wide before/after financial equality was not independently measured.
Schema/service tests that require absent public tables now need disposable-schema
isolation before they can be rerun against this migrated local database.
Source checkpoint archives do not back up the database.
Alerts, named operational responsibility, recovery-only/unlinked coverage and
deployed integration acceptance remain open. Staging readiness remains INCOMPLETE.


## Post-migration test isolation verified
Date: 2026-11-02
Schema and service tests now create private schemas and cloned fixture tables
inside their rollback-only transactions, without public search-path fallback.
Combined selected post-migration validation: 101 passed, zero failures or skips.
TypeScript and whitespace passed.
This supersedes the earlier outstanding test-isolation limitation.
Application runtime source is unchanged from successful build GAhRaB0OgAkN7e9UfJLqd.
Local browser claim/resolve/reopen and persisted audit sequence passed.
Local migrations 047 and 048 are applied; no deployed migration is claimed.
Alerts, named operational responsibility, recovery-only/unlinked coverage,
presentation cleanup and deployed acceptance remain open.
Staging readiness remains INCOMPLETE.
