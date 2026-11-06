# Exclusive local monitoring history locking

Prepared: 23 October 2026.

## Behaviour

An exclusive local lock file is created with wx and mode 0600.
Owner metadata records a PID and creation time. The file is synced before
work starts and removed after ordinary callback completion or failure.
An existing lock rejects the caller before its callback executes.
There is no waiting, expiry, automatic takeover or distributed coordination.

The separate locked command accepts:
POLICY_JSON PREVIOUS_JSON_OR_DASH NEXT_JSON IDENTITY_JSON LOCK_FILE.
Its lock covers bound-command preflight, prior history load, database reads,
snapshot publication, output and database cleanup.
The lock path must differ from the resolved input and output paths.
The bound command's local read-only database and schema checks still apply.

## Validation

Four unit cases passed initially. A later five-case run combined those four
with one disposable-schema database integration; TypeScript passed.
That integration exercises the saved history chain and source checks, verifies
ordinary lock cleanup and checks that an existing lock blocks pool creation.
The disposable database schema was removed and its absence verified.

Latest run: six cases passed, combining the four unit cases with two fresh
Node process rehearsals. One holds a live lock while another caller is
rejected; ordinary release permits the next owner.
The other terminates the lock-owning child and verifies the leftover lock
remains unchanged and rejects takeover. TypeScript passed.
These overlapping run counts must not be added.
Stage whitespace checked separately; no tests rerun during documentation.

## Operational limits

Every cooperating caller for a chain must use the same canonical lock path.
Different paths, path aliases or direct use of older commands can bypass it.
Trusted local directories and filesystem exclusive-create semantics are assumed.
Never delete or replace an active lock. Age or PID alone does not prove it is
safe to remove; process identity and any partially published output require
inspection. PID reuse and multi-host PID ambiguity are not resolved.
Cleanup failures can throw after a valid snapshot has already been published.
No power-loss durability guarantee or automatic crash recovery is provided.

The lock prevents overlap only. It does not establish the latest snapshot,
prevent sequential reuse of an old predecessor, or prevent a new dash-based
history from being started. Durable chain-head/predecessor tracking remains
the next implementation step.

No operational lock or history chain created. No production access, financial
dispatch, persistent application migration, activation, scheduling,
notifications, deployment, environment-file changes or commits.
