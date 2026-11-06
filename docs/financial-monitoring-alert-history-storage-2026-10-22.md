# Financial monitoring alert history serialization and local snapshots

Prepared: 22 October 2026.

## Serialization

A version-1 JSON envelope encodes retained history and restores evidence Date
objects when decoded. Validation reuses the planner and retention reducer.
Malformed timestamps, duplicate or fabricated conditions, inconsistent evidence,
unsupported versions and invalid source records fail visibly.
Encoded input is limited to 1 MiB and 256 pending conditions.
Validation does not authenticate state or bind it to a database environment.

## Local snapshots

Explicit save and load functions operate on caller-selected local paths.
Save validates state, exclusively creates a temporary file beside the target,
writes and syncs it, then publishes it with an exclusive hard link.
Existing snapshots are never overwritten. Normal completion removes the
temporary name; publication failure also attempts temporary-file cleanup.
A failure after publication can leave a valid target despite a thrown error;
callers must inspect the target rather than blindly retrying publication.

Load checks for a regular file and the size limit, reads and decodes it.
Missing, corrupt and oversized files fail; no empty history is substituted.
No parent directories, latest-file pointers or automatic cleanup are created.
The caller owns trusted directories, permissions and environment separation.
Hard-link support is required. This is not a hostile-path sandbox.
File sync does not establish power-loss durability of directory metadata.
A process crash may leave an unpublished temporary file.

## Validation and limits

Latest focused run: 14 tests across the codec and filesystem files passed;
zero failures, skips or cancellations. TypeScript passed.
Earlier codec plus retention run: 19 tests passed and TypeScript passed.
These counts overlap and must not be added.
Six filesystem tests use disposable directories and verify round trips,
non-overwrite publication, cleanup, invalid loads and missing parent handling.
A manually created partial temporary file simulates an interrupted write.
No live writer was terminated; power-loss, multi-process contention and
cross-process restart tests were not performed in this stage.

No operational history file was created. Monitoring-command integration,
snapshot selection, concurrent-update coordination and deployment storage
remain outstanding. Notification delivery and receipts remain absent.
Stage whitespace checked separately; no tests rerun during documentation.
No database changes, migrations, financial activation, scheduling, deployment,
environment-file changes, commits or normal staging changes.
