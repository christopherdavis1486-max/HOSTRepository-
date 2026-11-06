# Financial monitoring report exit-code validation

Prepared: 21 October 2026.

The report main function accepts an optional pool factory for integration testing.
Ordinary command usage still constructs its PostgreSQL pool with the existing
local identity guard, read-only default and connection/statement/lock timeouts.
Tests supply the temporary-table connection explicitly, avoiding module-loader mocks.

Seven real PostgreSQL fixture integrations validate main-function decisions:
- Exit 0: all ten reports recent and returned, with empty queues.
- Exit 0: all operations explicitly paused, with no heartbeat reports.
- Exit 2: missing heartbeat.
- Exit 2: stale heartbeat.
- Exit 2: recent threw outcome.
- Exit 2: overdue selected queue metadata.
- Exit 2: missing heartbeat schema.

Tests check serialized output, a single pool-factory invocation, cleanup,
read-only query execution and unchanged fixture metadata.
Temporary-only search paths prevent missing fixture tables falling back to public.
These integrations invoke main in-process and inspect process.exitCode; they
do not launch a complete child CLI process with temporary database fixtures.
Three existing subprocess tests cover missing and invalid policy inputs.

Validation: ten tests passed across two files; zero failures, skips or cancellations.
TypeScript passed after a type-only helper annotation accepted paused policy.
The earlier 140 monitoring tests were not rerun during this focused stage.

The initial module-mock harness failed its pool-cleanup assertion in seven cases.
Diagnostics showed that the injected pool was not used. Those failed main calls
used the ordinary read-only connection; their exit-code checks did not complete.
The corrected tests explicitly supply the fixture pool and passed all seven cases.

No production policy, notification delivery or scheduling added.
No financial workers/providers invoked, persistent migration applied, activation,
deployment, environment-file changes or commits. Stage whitespace checked.
