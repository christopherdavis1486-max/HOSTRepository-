# Read-only monitoring history chain inspection

Prepared: 24 October 2026.

## Behaviour

The library inspector validates the existing numbered chain, predecessor
hashes, bound identity, retained evidence and nondecreasing assessment times.
It returns the latest state, head, record path and count without advancing.
An empty chain returns null head/state/file and recordCount zero.
The CLI emits only stored-history summary fields, not retained evidence.

The inspector does not create a lock, write records, remove files, repair
history, query a database or invoke financial workers.
An existing .chain.lock causes refusal and remains unchanged.
Unexpected entries, temporary files, sequence gaps and invalid records fail.
The inspector allows inspection at 10000 records, where advancement stops.

Record names and bytes are rechecked after validation to detect changes.
All writers must nevertheless be stopped: rechecks are not a transactional
filesystem snapshot and cannot rule out all concurrent changes.
Trusted local directories and immutable-record discipline remain required.
Hashes and validation do not authenticate data or prevent deliberate rollback.

## Command

scripts/inspectFinancialMonitoringHistoryChain.ts CHAIN_DIRECTORY IDENTITY_JSON

No database or environment file is required. Keep identity outside the chain.
Output: scope, recordCount, head, assessedAt and pendingCount.
Exit 0 means inspection succeeded, even with pending conditions.
Exit 1 means inspection failed, with generic stderr and no success output.
This command does not establish fresh monitoring health or financial recovery.

## Validation

Twelve tests passed across the inspector and existing chain-store files.
Seven new cases cover empty chains, pending evidence and detached results,
identity mismatch, existing locks, invalid linkage/evidence, gaps/temporary
files, and actual CLI success/failure with path redaction.
Five existing chain-store cases passed in the same run. TypeScript passed.
Tests use disposable directories; no database access or operational chain.
Controlled changes during inspection, the 10000-record boundary, killed chain
publication and uncertain-commit recovery were not rehearsed in this stage.
Stage whitespace checked separately; no tests rerun during documentation.

## Follow-up

The inspector and writer currently contain equivalent duplicated validation
logic. Future format changes must keep both aligned or extract a shared reader.
Recovery decisions must reconcile the validated head with independent operator
evidence. Inspection does not automatically establish commit attribution.
No automatic repair, lock takeover, scheduling or notification delivery added.
No production access, migration, activation, deployment, environment changes
or commits. Normal staging preserved.
