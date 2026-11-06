# Compliance evidence URL validation — 30 October 2026

## Problem
Malformed non-empty evidence URLs were accepted by draft schema validation.
A value beginning ": https://" reached PostgreSQL and violated its evidence
URL constraint, producing a generic compliance save error.

## Change
Validate populated evidence links on required items for both drafts and
submissions. Links must start with lowercase https://, parse with a hostname,
and contain no whitespace after trimming.
Validation messages identify the compliance category.
Blank draft links remain permitted.
Submission still requires valid evidence links.
Not-applicable items continue to ignore stale hidden evidence values.

## Verification
13 compliance tests passed, including:
- Exact malformed-link regression for drafts and submissions.
- Blank, null and omitted draft links.
- Valid URL trimming.
- Not-applicable hidden evidence values.
- Actual PUT route loaded with mocked authentication/access and save service.
- Invalid links return HTTP 400 INVALID_INPUT without calling the save service.
- Valid trimmed links reach the save service with server-derived identity.

TypeScript and tracked whitespace checks passed.
Original schema and test files were backed up before editing.

## Limits
Browser rendering of the new error has not yet been verified.
The route save service was mocked; no database writes or real provider
requests were made by these regression tests.
No deployment, migrations, financial activation, environment-file changes,
commits or staging changes were performed.
