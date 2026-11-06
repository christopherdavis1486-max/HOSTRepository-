# Financial monitoring failure rehearsals

Prepared: 22 October 2026.

## Database-handshake outage

The actual history CLI connects to a disposable loopback TCP server that
accepts TCP but never completes the PostgreSQL handshake.
The command exited 1 with generic stderr and no stdout after approximately
5229 ms. Prior snapshot bytes were preserved and no next snapshot appeared.
The TCP server and disposable files were cleaned up. PostgreSQL was not stopped.
This tests connection establishment failure, not an outage during a query.

## Heartbeat write rejection

A trigger on a temporary heartbeat table raises controlled PostgreSQL error
42501 for INSERT or UPDATE according to a fixture session setting.
A rejected start prevents callback invocation and creates no heartbeat row.
A rejected completion preserves the callback return value, invokes it once,
reports write_failed and leaves started metadata with no finished timestamp.
These are injected server-side rejections, not an actual role-permission test.

The first fixture incorrectly assumed read-only transactions reject temporary
table writes. PostgreSQL permits those writes. A trigger replaced that setup.
An independent trigger setup hook initially ran before connection initialization;
moving trigger creation into the original sequential setup corrected it.

## Interrupted fixture callback

A fresh child process runs the real heartbeat wrapper around a harmless
callback. Its heartbeat query is relayed over IPC to the parent's temporary
PostgreSQL table connection. The child is terminated after entering the callback.
Exactly one start query and one callback entry are observed; no completion
query occurs. Stored outcome remains started with finished_at null.
Assessment at reportedAt plus 60001 ms marks it stale without altering storage.
This uses an explicit assessment time rather than waiting a minute.

The parent connection survives. This does not terminate a financial worker,
provider operation or financial transaction, and does not test recovery of
financial side effects. It establishes wrapper monitoring behaviour only.

## Validation

One outage test passed in its own run. Three corrected runner rehearsals
passed in another run. These are four distinct cases across two files.
TypeScript passed after a type-only non-null annotation for explicitly piped
child streams. Runtime tests were not rerun after that annotation.
Stage whitespace checked separately; no tests rerun during close-out.
No persistent heartbeat migration, application-table changes, financial
dispatch, activation, notifications, deployment, environment changes or commits.
