# Monitoring history publication failure rehearsals

Prepared: 24 October 2026.

## Verified cases

Three child-process fixtures exercise the real chain store and inspector.
The child replaces fs.linkSync only within its own process to inject errors.

1. Error before hard-link publication: no committed record remains.
2. Error immediately after a successful hard link: the call fails, but the
   fully validated record remains committed after ordinary cleanup.
3. Fixture error after advancement resolves but before printing success:
   the child exits 1 without stdout, while the record remains committed.

All children exit 1, print a generic fixture error and produce no stdout.
Ordinary temporary-file and lock cleanup completes in these scenarios.
Read-only inspection confirms empty or committed state as appropriate.
When committed, retrying initialization with the old null head fails before
its callback runs. Existing bytes remain unchanged. A deliberate fixture
continuation from the inspected current head produces the second record.
When no record was committed, explicit fixture initialization succeeds.

## Validation

Ten tests passed across two files with concurrency 1: three new publication
rehearsals and seven existing inspector tests. Zero failures, skips or
cancellations. TypeScript passed.
The inspector tests overlap earlier runs; counts are not additive.
Tests use disposable local directories and supplied empty-history fixtures.
No database, provider, operational snapshot chain or financial worker used.
Stage whitespace checked separately; no tests rerun during documentation.

## Limits

The lost-output case throws in the fixture after the module resolves; it does
not inject a real stdout transport failure into the database-backed CLI.
No process is killed during publication. Temporary-file unlink, lock unlink,
close, fsync and directory-metadata power-loss failures are not injected.
No automatic lock deletion, takeover, repair or operational retry is added.
Inspection establishes stored-chain validity, not authenticated attribution
of a record to an uncertain operational invocation.
Manual decisions still require stopped writers, preserved evidence and an
independent accepted-head record. Hashes do not prevent deliberate rollback.

No production access, persistent database changes, migration, activation,
scheduling, notification delivery, deployment, environment changes or commits.
