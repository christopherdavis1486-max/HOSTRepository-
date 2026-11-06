# Monitoring history cleanup and interruption validation

Prepared: 24 October 2026.

## Cleanup failures

Two isolated child processes inject fs.unlinkSync failures after publication.
Temporary-name failure leaves the numbered record and matching temporary
bytes; ordinary lock cleanup succeeds. Full inspection and advancement reject
the unexpected entry, preserve all files and invoke no further callback.
Lock unlink failure leaves the numbered record and owner metadata. Inspection
refuses the lock and advancement fails EEXIST before work, preserving bytes.
Both children exit 1 without stdout and report exactly one injected failure.
Bound decoding verifies the committed fixture state in both cases.

## Interrupted publication

Two child processes wrap fs.linkSync and suspend at a controlled boundary.
The parent receives an IPC marker and terminates the child with SIGKILL.
Before publication: a complete synced temporary record and lock remain,
with no numbered record. After publication: the numbered record, matching
temporary bytes and lock remain. Owner PID matches the terminated child.
Inspection refuses the lock. Advancement refuses takeover before callback
invocation. All surviving bytes remain unchanged throughout those checks.
This tests real process termination around a wrapped publication boundary,
not interruption inside an operating-system syscall or power loss.

## Validation

Initial focused run: five cases across cleanup and earlier publication-error
files passed. Latest run: four cases across cleanup and interrupted-publication
files passed. The two cleanup cases overlap; run counts must not be added.
There are four new cases in this stage. TypeScript passed after the latest run.
No failures, skips or cancellations in either run.
All fixtures are disposable local directories. No database or provider access.
Only test files and documentation added or changed; production modules unchanged.
Stage whitespace checked separately; no tests rerun during documentation.

## Interpretation and remaining limits

The planned local unlink-failure and interrupted-publication rehearsals passed.
These establish preserved evidence and refusal of unsafe continuation, not
automated repair, successful manual recovery or authenticated attribution.
No operational lock or record was removed. Test teardown disposes fixtures
only after confirmed child exit; it is not a recovery procedure.
Power-loss durability, fsync/close failures, arbitrary interruption points,
actual database CLI stdout transport failure and financial crash recovery
remain outside these tests. Inspector controlled-mutation tests and shared
validation refactoring also remain separate follow-up work.

No operational history chain, production access, persistent migration,
financial activation, scheduling, notifications, deployment, environment-file
changes or commits. Normal staging preserved.
