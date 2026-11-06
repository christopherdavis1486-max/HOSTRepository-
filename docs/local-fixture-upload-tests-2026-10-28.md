# Local fixture and upload-route tests - 28 October 2026

## Repeatable limiter tests
- Added scripts/localRateLimitFixture.test.ts.
- Four tests passed with zero failures, skips or cancellations.
- Used the installed Upstash client against temporary loopback HTTP fixtures.
- Covered five allowed requests followed by rejection, identifier isolation,
  previous-window weighting, rollover, decay and expired-bucket behavior.
- Covered unsupported scripts, commands and parameters without consuming allowance.
- Covered fixture authentication, malformed JSON, pipeline limits and sequential
  pipeline results.
- Successful client results were checked against timeout fallback.
- TypeScript and test-file whitespace checks passed after this file was added.
- The fixture is an in-memory protocol adapter, not Redis or production Upstash.

## Upload callback runtime tests
- Added lib/hosts/propertyImageUpload.runtime.test.ts.
- Five tests passed; repeated runs are not added together.
- Executed transpiled upload-route source in a VM with explicit import adapters.
- Mocked authentication, property access, Blob handleUpload/head and image registration.
- Covered token ownership and server identity, allowed types and size configuration,
  unauthenticated/cross-owner rejection, missing/malformed/wrong-property payloads,
  verified-head metadata registration and Blob-head failure.
- Initial TypeScript check rejected Object.hasOwn under the ES2020 project library.
- Replaced it with Object.prototype.hasOwnProperty.call.
- Preserved the original test as .before-es2020-fix.bak.
- This stage changed test files only; application behavior was not modified.

## Limits
- Upload callback signature verification remains delegated to the mocked SDK.
- Actual Blob upload, image persistence, cover selection and deletion were not
  established by these new tests.
- No database or external provider requests were made by these tests.
- No deployment, migration, financial activation, environment-file change or commit.
- Normal Git staging and backups were preserved.
