# Financial monitoring full CLI validation

Prepared: 22 October 2026.

## Exit 1 subprocess cases

Six tests launch the actual history CLI in fresh Node processes.
They cover missing arguments, malformed policy, missing previous snapshot,
corrupt previous snapshot, existing next snapshot and invalid database URL.
Each verifies exit 1, no stdout and generic error output without the private
database value. Selected cases also check path redaction and preserved files.
These cases use invalid configuration and do not connect to PostgreSQL.

## Database-backed process chain

One integration test launches four actual CLI processes against a uniquely
named disposable schema in loopback host_test, with public excluded from
the child search path. Six monitoring tables are created in that schema.
Child connections use read-only defaults and connection/statement/lock limits.

- Explicitly paused policy with empty monitoring tables exits 0.
- Running policy with missing reports exits 2 and saves ten pending conditions.
- Missing heartbeat schema exits 2, retaining those ten conditions as
  unconfirmed and adding the source-level schema condition.
- Recent returned reports exit 0 and clear all eleven pending conditions.

Every command writes an immutable next snapshot, whose decoded state matches
its output. Earlier missing/unavailable snapshot bytes remain unchanged.
The disposable schema is dropped and its absence verified; file fixtures
are removed. Existing application tables are outside the fixture search path.

## Validation and limits

Six CLI failure tests passed in one run. The database-backed chain passed as
one test in a separate run. These are seven test cases, not seven CLI launches.
TypeScript passed after a type-only correction explicitly used PoolClient
instead of ReturnType on the overloaded pool.connect method.
The database runtime test and schema cleanup passed before that correction.
No runtime tests rerun during the type-only correction or this close-out.
Stage whitespace checked separately; wider suites were not rerun.

This covers actual CLI exits 0, 1 and 2 and saved-history continuation.
It does not cover database outage, killed financial runners, killed snapshot
writers, power-loss durability, concurrent history chains or delivery receipts.
Operational scheduling, notification delivery and production policy remain
outside this stage. No operational snapshot chain was created.

No financial workers/providers invoked, persistent application migration
applied, financial activation, deployment, environment-file changes or commits.
