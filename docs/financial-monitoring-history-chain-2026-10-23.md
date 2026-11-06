# Financial monitoring history chain

Prepared: 23 October 2026.

## Storage and predecessor checks

A dedicated caller-owned local directory contains numbered immutable records.
Each record contains its sequence, predecessor SHA256 and bound history.
The head is the SHA256 of the complete latest record bytes.
The directory is resolved through realpath and its .chain.lock is held while
validating existing records, checking the expected head, collecting and
publishing the next record.

Expected null initializes only an empty directory. Otherwise the supplied
head must equal the latest validated record hash before work is invoked.
Sequence gaps, broken linkage, wrong identities, invalid history, backward
assessment times and unexpected entries fail visibly.
Records are limited to 2 MiB; bound histories retain their 1 MiB limit.
The store refuses advancement when 10000 records already exist.
Every advancement rereads and validates the full chain; work grows with history.

Publication writes and syncs an exclusive temporary file, then creates an
exclusive hard link at the next numbered path. Earlier records are preserved.
Callback failure before publication leaves no new committed record.
Cleanup or output failure after publication can still leave a committed record.
Inspect and validate storage before retrying; do not reset history with dash.

## Command

scripts/reportFinancialMonitoringHistoryChain.ts accepts:
POLICY_JSON CHAIN_DIRECTORY EXPECTED_HEAD_OR_DASH IDENTITY_JSON.
The chain directory must already exist and contain only its own records.
Policy and identity files belong outside it.
Dash initializes an empty chain. Continuation requires the current head hash.
Successful output includes chain.head and chain.file alongside the report.
Exit 0 means no pending monitoring conditions; exit 2 means pending conditions.
Exit 1 indicates command failure. No exit establishes financial completion.

The command retains loopback host_test, read-only session and explicit schema
verification. All collection uses the verified connection. Database cleanup
finishes before the chain store publishes the returned state.
The store releases its lock before the command prints its committed result;
another caller could advance the chain before that output is observed.

## Validation

Initial run: five chain-store tests plus four existing lock tests passed.
Latest run: five chain-store tests plus one database CLI integration passed.
These overlapping run counts must not be added. TypeScript passed.
The database case launches seven separate CLI processes: four history steps
and three rejected attempts using dash or older heads.
Missing conditions survive unavailable evidence and later clear.
All four committed records remain unchanged after rejected stale attempts.
The disposable schema was removed and its absence verified.
Stage whitespace checked separately; no tests rerun during documentation.

## Limits

This is a trusted local file chain, not authenticated or distributed storage.
Hashes do not prevent deliberate rewriting, replacement, cloning or rollback.
Deleting records and supplying a matching old head is outside this protection.
Independent directories can form independent chains; no global registry exists.
All writers must use this API and preserve the complete chain directory.
Older standalone snapshot commands do not gain predecessor tracking.
No automatic repair, retention deletion, compaction, stale-lock takeover or
power-loss durability guarantee is provided. A crash can leave a lock or
temporary file that blocks advancement pending manual inspection.
Killed writers during chain publication were not tested in this stage.
Environment labels remain operator supplied; server-cluster identity is absent.

No operational history chain created, financial workers invoked, production
access, persistent application migration, activation, scheduling, notification
delivery, deployment, environment-file changes or commits.
