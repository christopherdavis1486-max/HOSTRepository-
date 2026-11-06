# Financial monitoring history separate-process validation

Prepared: 22 October 2026.

Three tests launch fresh Node processes using the real retention, codec and
local snapshot modules. Observation fixtures and snapshots use disposable
directories. Child processes do not query a database or invoke workers.

## Verified behaviour

- One process saves ten missing-heartbeat conditions.
- A later process loads that snapshot and retains the conditions as unconfirmed
  when heartbeat evidence is unavailable, adding the source-level finding.
- Another process loads the next snapshot and clears all eleven conditions
  when recent returned reports are supplied.
- Earlier snapshot bytes remain unchanged; the final saved state reloads empty.
- A fresh process rejects corrupt prior history without creating next state.
- A fresh process refuses to replace an existing next snapshot.

The child fixture reports its PID, and tests verify it differs from the parent.
Each successful step is a separate process invocation; no in-memory history
is passed between processes. State travels through saved snapshot files.

## Scope and limitations

This validates module-level restart retention with supplied observation fixtures.
It does not launch the database-backed monitoring CLI or verify its exit-2 path
in a child process. The child fixture uses exit 0 for successful persistence
and exit 1 for errors, independently of monitoring attention status.
Database-backed command behaviour was validated separately in-process.
No writer is killed, no power loss is simulated, and concurrent history-chain
coordination remains outside this validation.
No operational snapshot chain, scheduler or notification delivery is created.

## Validation

Three tests passed in one file; zero failures, skips or cancellations.
TypeScript passed. Stage whitespace checked separately.
The initial generator failed during parsing because nested template literals
were constructed incorrectly; it created no file and ran no tests.
The corrected generator created the test file and all three tests passed.
No tests rerun during documentation; wider suites were not rerun.
No database changes, migrations, financial activation, deployment,
environment-file changes, commits or normal staging changes.
