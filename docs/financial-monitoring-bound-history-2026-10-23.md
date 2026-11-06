# Bound financial monitoring history

Prepared: 23 October 2026.

## Format and storage

A version-2 envelope binds the existing validated history to explicit
environment, database and schema identifiers. All three must match on load,
including when the history contains no pending conditions.
Identifiers are bounded labels, not connection strings or credentials.
Legacy unbound snapshots are rejected by the bound API; no automatic
conversion or silent history initialization is provided.
Existing version-1 modules and the original history command remain unchanged.

Bound file storage retains exclusive immutable hard-link publication,
temporary-file cleanup and the 1 MiB limit. Existing files are preserved.
Trusted local directories and hard-link support remain required.
File sync does not establish power-loss durability of directory metadata.
An error after publication can leave a valid output; inspect before retrying.

## Bound command

scripts/reportFinancialMonitoringBoundHistory.ts accepts four arguments:
POLICY_JSON PREVIOUS_JSON_OR_DASH NEXT_JSON IDENTITY_JSON.
The identity file contains environment, database and schema string fields.
Dash explicitly starts a new history; a named previous file must load and match.
The command remains restricted to loopback host_test and read-only sessions.

After verifying database identity, the command selects the explicit schema
and checks the resolved namespaces of all six monitoring relations.
Missing relations remain collection findings. Relations resolved outside the
selected schema are rejected, including temporary-table shadowing.
Collection uses one checked-out verified connection; the queue reader still
owns its read-only transaction. Queue and heartbeat reads are not one shared
transactional snapshot. The connection is discarded when the command finishes.

Output follows successful snapshot publication. Exit 0 means no pending
monitoring conditions, exit 2 means pending conditions, and exit 1 is failure.
No exit establishes financial completion or recovery.

## Validation

Five new codec tests and eight existing codec tests passed together: 13 cases.
Four new filesystem tests, five bound codec tests and six existing filesystem
tests passed together: 15 cases. These run counts overlap.
The latest database integration passed as one test case, containing nine CLI
subprocess launches and one in-process temporary-table shadow rejection.
It covers exits 0/2, saved missing conditions retained through unavailable
heartbeat schema and later cleared, three identity mismatch rejections,
nonexistent/reserved schema rejection, and shadow rejection with cleanup.
Earlier snapshot bytes remain unchanged. The disposable database schema
was removed and its absence verified. TypeScript passed after the latest run.
Stage whitespace checked separately; no tests rerun during this close-out.

## Limits and follow-up

Identity labels are not authentication or cryptographic integrity protection.
The environment label remains operator supplied. Database name and schema do
not uniquely identify a server cluster, port, restored database or tenant.
Source checks assume trusted schema ownership and no concurrent hostile DDL.
The original unbound command remains available and does not gain these checks.
Concurrent history-chain coordination, notifications, delivery receipts and
operational policy decisions remain outstanding. No operational chain created.

No production access, financial dispatch, persistent application migrations,
activation, scheduling, deployment, environment-file changes or commits.
