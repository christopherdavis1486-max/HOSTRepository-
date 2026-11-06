# Combined financial monitoring ? 21 October 2026

## Behavior

Combines queue scheduling assessments with heartbeat freshness and stored
callback outcomes for all ten operations. One explicit operator policy supplies
expected runner states to both assessments; reports never infer pause from silence.
Recent reporting and callback return do not establish financial success.
Started, returned and threw outcomes remain visible independently of freshness.

Collection handles each source independently and sequentially. Missing schema
and other collection failures remain unavailable instead of fabricated empty reports.
Malformed successful reader output fails assessment visibly.
Policy is validated before collection and copied before awaiting reads.
Collection does not establish one shared snapshot across both sources.

The explicit local report command requires a policy JSON path, loopback host_test,
read-only connections and bounded connection/statement/lock waits.
It invokes no workers or providers and sends no notifications.
Exit 1 indicates command/configuration failure; exit 2 indicates monitoring
attention; exit 0 means its configured observations require no attention.
None of these exit codes establishes financial completion.
Unfinished recent callbacks remain visible as started; no runtime-duration
threshold or periodic pulse is introduced.

## Validation

Latest combined run: 137 tests passed across eight files; zero failures,
skips or cancellations. TypeScript passed. Includes 29 new tests:
13 combined assessment, seven collector, six database integration and three CLI.
Database fixtures use temporary queue/heartbeat tables and a temporary-only
search path. Collection read-only behavior and unchanged metadata are checked.
The CLI tests cover rejected inputs; real local rehearsal covers attention exit 2.
A full successful-schema CLI exit-0 rehearsal is not included.

The first combined run passed 134 tests and failed three populated database
cases because their queue assessment was unavailable. Diagnostic assertions
were added; those three passed individually and all 137 passed on combined rerun.
The initial failure reason was not captured, so its cause remains unresolved.
The passing rerun does not establish that the intermittent issue was fixed.

Saved local report rehearsal used empty operation policy: every state unknown.
Queue collection was available; heartbeat schema was unavailable as expected
because migration 047 remains unapplied to persistent host_test.
Rehearsal freshness thresholds are not a production policy recommendation.

## Remaining operational work

Investigate any recurrence using retained queue diagnostic assertions.
Production runner policy, monitoring roles, scheduling, alert routing and
escalation remain outstanding. No production rollout or capacity claim.
No financial authorization, selector or worker implementation changes.
No persistent migration application, financial activation, environment changes
or commits. Tests and local report were not rerun during documentation close-out.
