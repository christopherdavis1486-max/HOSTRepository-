# Local financial monitoring operator runbook

Prepared: 22 October 2026. Updated: 23 October 2026.

## Purpose and current status

Use the chain command for coordinated local history collection. It reads
monitoring metadata, retains pending conditions and publishes an immutable
numbered record. It never invokes financial workers or providers.
It is restricted to loopback host_test and verified read-only sessions.
No operational policy, schedule or history chain has been created.
Migration 047 has not been applied to persistent application schemas in this
work. Missing monitoring schema is unavailable evidence, not permission to
apply migrations or activate financial workers.

## Prerequisites

- Confirm repository, branch, local database and schema ownership.
- Review intended running, paused and unknown states for all ten operations.
- Choose operational thresholds separately from synthetic rehearsal values.
- Policy requires positive maxSnapshotAgeMs and maxHeartbeatAgeMs; running
  queue assessment also requires dueReviewAgeMs.
- Prepare an identity JSON containing exactly environment, database and schema.
  Database must be host_test. Environment is an operator-supplied label.
- Identity labels use 1-128 ASCII letters, digits, dots, underscores or hyphens,
  beginning with a letter or digit. They contain no connection credentials.
- Select an existing trusted local directory outside the repository, dedicated
  to one chain. Keep policy, identity, output captures and backups outside it.
- Confirm filesystem hard-link support and appropriate directory permissions.
- All writers must use the chain API and the same real directory.

Database and schema checks do not uniquely identify a server cluster, port,
restored database or tenant. Labels and hashes do not authenticate files.
Do not use the synthetic rehearsal policy for operational collection.

## Command templates

These are templates only; do not execute until policy and storage are reviewed.
Run from C:/Users/artem/Downloads/HOST-batch13A.

Initialize an intentionally new, empty chain directory:

~~~powershell
node --import tsx --env-file=.env.test.local .\scripts\reportFinancialMonitoringHistoryChain.ts '<reviewed-policy.json>' '<existing-empty-chain-directory>' '-' '<reviewed-identity.json>'
$monitoringExit = $LASTEXITCODE
~~~

Continue using the accepted current head hash:

~~~powershell
node --import tsx --env-file=.env.test.local .\scripts\reportFinancialMonitoringHistoryChain.ts '<reviewed-policy.json>' '<existing-chain-directory>' '<current-64-character-lowercase-head-hash>' '<reviewed-identity.json>'
$monitoringExit = $LASTEXITCODE
~~~

The command creates the next numbered record; do not supply a next-file path.
Capture LASTEXITCODE immediately. Output contains chain.head and chain.file.
Dash is accepted only for an empty chain. Never clear storage or select a
different directory merely to bypass a stale-head or damaged-chain error.

## Exit codes and evidence

| Exit | Meaning | Operator action |
| --- | --- | --- |
| 0 | No pending conditions under supplied policy | Review report and record the committed head |
| 2 | Active or retained unconfirmed conditions | Preserve the committed record and investigate |
| 1 | Configuration, collection, storage or output failure | Inspect storage before deciding whether retry is safe |

Exit 0 can follow explicit pause. Recent means reporting recency; returned
means callback return, possibly with disabled work. Neither proves financial
success. Cleared refers to a named monitoring condition, not financial recovery.
Continuing does not prove notification delivery or acknowledgement.

## After exit 0 or 2

1. Review assessedAt, source availability, transitions and pending evidence.
2. Confirm chain.file is the new numbered record in the intended directory.
3. Record chain.head and chain.file in an operator log outside that directory.
4. Preserve all earlier records unchanged and back up the complete directory
   while writers are stopped, along with separately recorded head evidence.
5. Use the accepted head for continuation; do not infer order from file dates.

The lock is released before stdout is printed. Another writer may already
have advanced the chain when a printed head is observed. A rejected stale
head is a coordination signal; do not blindly choose another head and retry.

## Failure handling

### Stale head or repeated initialization

The callback is not invoked when the validated current head differs.
Check the operator log and any other writer. Preserve records and reconcile
which observations were committed before continuing. Do not use dash to reset.

### Existing .chain.lock

Do not remove it based on age or PID alone. Identify the owning process and
machine, account for PID reuse, and establish that every writer has stopped.
Preserve the directory and lock as evidence. Review all records and temporary
files before any separately reviewed manual recovery action.
No automatic expiry, takeover or stale-lock removal procedure is implemented.

### Failure during publication or output

Exit 1 or absent stdout does not prove no record was committed. A hard link
may have published a complete record before temporary-file or lock cleanup
failed. Output failure can also occur after successful commit.
Stop writers and preserve the complete directory before investigation.
Check sequence, predecessor hashes, bound identity and full retained-evidence
validation; valid JSON or a single file hash is insufficient.
A dedicated read-only chain inspection command is now available; see below.
Do not invoke advancement as an inspection tool: it can collect and publish.
If commit status cannot be established, stop rather than guessing a head.

### Unexpected entries, temporary files, corrupt records or sequence gaps

A leftover .record-*.tmp blocks advancement. Do not delete, rename or promote
it automatically. Do not edit records or remove a suffix to make validation
pass. Preserve evidence and use a separately reviewed recovery procedure.
The chain has no automatic repair, compaction or retention deletion.

### Database identity, schema, connection or clock failure

Check intended local configuration without exposing secrets. Missing sources
may produce exit 2 with unavailable evidence; database-clock failure propagates.
No record does not mean healthy state. Do not restart services, change
environment files or apply migrations solely to make this report pass.

### Interrupted financial runner

A completion-heartbeat write can fail after a callback returns. Started
metadata can become stale during a long or interrupted callback. Do not
replay financial work, reset claims or retry providers from heartbeat status.

## Storage and compatibility limits

Each advancement validates the complete chain; cost grows with record count.
The store refuses advancement once 10000 records exist. Plan archival or
compaction separately before that limit; do not delete records in place.
Bound history is limited to 1 MiB; each chain record is limited to 2 MiB.
File sync does not guarantee directory-metadata durability after power loss.
Trusted storage is required; deliberate rewriting, cloning or rollback is
not prevented. Independent directories can form independent chains.

The original history command still uses unbound standalone snapshots.
The bound command adds identity checks but no chain predecessor tracking.
The locked standalone command prevents overlap only for a shared lock path.
Do not treat these older commands as interchangeable with the chain command.
No automatic import of standalone snapshots into a chain is implemented.

## Validation and deferred work

Local tests cover bound identity mismatches, explicit schema checks, temporary
table shadow rejection, live-owner lock contention, terminated-owner leftover
locks, chain linkage and stale-head rejection, and database-backed CLI history.
Child termination at controlled publication boundaries has been tested locally.
Power-loss durability and interruption inside operating-system calls are untested.
No production policy, scheduling, notification delivery or financial activation.

Related documents:
- financial-monitoring-bound-history-2026-10-23.md
- financial-monitoring-history-locking-2026-10-23.md
- financial-monitoring-history-chain-2026-10-23.md
- development-handover-2026-10-23.md

## Read-only chain inspection - 24 October 2026

Stop every writer before inspection. The inspector creates no lock and cannot
provide a transactional filesystem snapshot. It refuses an existing lock;
that refusal does not authorize deleting the lock. Follow the owner and
evidence checks above before any separately reviewed manual recovery.

Template only, with reviewed paths outside the chain for identity and output:

~~~powershell
node --import tsx .\scripts\inspectFinancialMonitoringHistoryChain.ts '<chain-directory>' '<reviewed-identity.json>'
$inspectionExit = $LASTEXITCODE
~~~

No environment file or database connection is needed. Exit 0 means the stored
chain validated, including an empty chain or one with pending conditions.
Exit 1 means inspection failed. This differs from the collection command's
exit-2 attention status. Inspection never assesses fresh evidence.

Output contains recordCount, head, assessedAt and pendingCount. Compare the
validated head with the separately accepted operator record before deciding
how to continue. Inspection does not authenticate the chain, prove that it
belongs to a particular failed invocation or authorize automatic retries.

Names and bytes are rechecked during inspection, but writers must remain
stopped. Leftover temporary files, gaps, invalid linkage and invalid evidence
fail visibly without repair. Controlled pre-publication, post-publication and
lost-output error rehearsals now pass. Temporary-name and lock unlink failures,
and child termination immediately before/after publication, also pass locally.
Power-loss recovery remains untested. See financial-monitoring-chain-inspection-2026-10-24.md.

## Publication failure evidence - 24 October 2026

Three controlled child-process rehearsals use the real chain store and reader.
A failure before hard-link publication leaves no committed record. An injected
error immediately after the hard link leaves a valid committed record despite
a failed call. A fixture error after successful advancement but before success
output likewise leaves the record committed.

After ordinary cleanup, read-only inspection identifies the stored head.
Retries using the old expected head are rejected before callback invocation.
Tests then continue from the inspected head within disposable fixtures only.
This does not authorize automatic operational recovery or retries.

The earlier publication-error cases are module-level injections, not actual
CLI stdout transport or financial-worker tests. Separate local unlink-failure
and killed-publication-boundary rehearsals are now documented below.
Power-loss durability remains untested.
No leftover operational lock was removed. Continue to stop writers, preserve
evidence and reconcile the inspected head with independent operator records.

## Cleanup failure and interrupted publication evidence - 24 October 2026

Injected temporary-name unlink failure leaves a valid committed record and
its temporary name. Ordinary lock cleanup succeeds, but inspection and further
advancement reject the unexpected temporary entry without changing it.

Injected lock unlink failure leaves a valid committed record and the lock.
Inspection refuses the lock, and advancement refuses takeover before work.

A child suspended immediately before hard-link publication and then terminated
leaves a complete synced temporary record and lock, but no numbered record.
Termination immediately after the hard link leaves the numbered record,
temporary name and lock. Both block inspection and continuation unchanged.

These tests validate conservative refusal, not an automatic recovery workflow.
Do not infer that a temporary record is committed, promote it, or remove locks
based solely on these results. Stop writers, preserve evidence and review the
specific incident before any manual action. Tests remove only disposable
fixture folders during teardown after the child has exited.

No power loss, termination inside an OS write/link call, failed fsync/close,
live database CLI interruption or financial side-effect recovery was tested.
See financial-monitoring-cleanup-interruption-validation-2026-10-24.md.
