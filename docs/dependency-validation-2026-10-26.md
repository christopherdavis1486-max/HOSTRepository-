# HOST dependency validation - 26 October 2026

## Changes
- Updated installed Next.js from 15.5.25 to 15.5.28, including matching env and Windows SWC packages.
- Updated sharp to 0.35.5, source-map-js to 1.2.2 and shared undici 6 to 6.29.1.
- Migrated application Zod from 3.25.76 to pinned 4.6.7.
- Replaced three errorMap options with error and two Zod error.errors accesses with error.issues.
- Added six validation contract tests, verified before and after the Zod migration.
- Added a scoped @vercel/cli-config Zod dependency override to 4.6.7.
- Preserved existing package overrides.
- jsdom 30.1.3 was added during the previous day's completed integration-test stage.

## Verified evidence
- Final selected validation/onboarding regression run: 34 reported passes, including the mounted React parent test; zero failures, skips or cancellations.
- Separate property-location run: 12 passes.
- Separate compliance validation/source-check run: nine passes.
- Separate database-backed property run: 13 passes against guarded loopback host_test.
- Repeated supplied output is not counted as additional test runs.
- TypeScript passed after the final dependency override.
- Changed tracked files passed git diff --check.
- Sharp processed an in-memory image successfully.
- Vercel exported config parsers accepted/rejected fictional in-memory inputs as expected.
- npm audit reported zero dependency-tree vulnerabilities after the updates.

## Unresolved bundled dependency
- The exported @vercel/cli-config entry still contains bundled Zod identifying itself as 4.1.11.
- That entry did not contain a require of the overridden Zod dependency.
- The scoped override therefore does not establish remediation of the bundled copy.
- Exploitability and affected-path reachability have not been established.
- A zero-finding npm audit is not evidence that embedded bundled code was updated.
- This remains an outstanding dependency assessment/remediation item.

## Database scope
- Property tests verified the connected database name host_test and loopback server address before execution.
- All twelve ENABLE_* feature flags were disabled for that run.
- Tests created fictional users, host profiles and properties and retained those rows.
- Tests covered amenity persistence, partial updates, ownership restrictions and incomplete-publication blocking.
- These tests do not establish the browser fresh-host publication flow.
- Source checkpoints do not back up database rows.

## Backups
- HOST-next-patch-backup-2026-10-26
- HOST-transitive-patch-backup-2026-10-26
- HOST-zod-migration-backup-2026-10-26
- HOST-vercel-zod-override-backup-2026-10-26
- Backups were verified before their corresponding changes and preserved.

## Limits and constraints
- No production build or browser smoke test after these upgrades has been reported.
- No successful Stripe onboarding, deployed staging verification or launch approval is established.
- No deployments, migrations, financial activation, environment-file changes or commits.
- No real Stripe or email requests were part of this dependency-validation workflow.
- Package installation scripts were disabled; normal Git staging was preserved.
