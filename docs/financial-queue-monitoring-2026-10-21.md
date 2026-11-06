# Financial queue monitoring assessment

Prepared: 21 October 2026.

This stage assesses scheduling snapshots only. It does not send notifications,
schedule reports, verify runner heartbeats, inspect provider evidence or invoke
financial work. No production thresholds or polling interval are configured.

## Explicit policy

The caller supplies a positive maximum snapshot age. Each operation may have
an expected state of running, paused or unknown. A running operation also
requires an explicit due-review age threshold for a configured assessment.

Missing operation context is unknown. Expected runner state is operator
context, not a verified financial gate, scheduler setting or worker heartbeat.
No default age threshold is inferred from local profiling.

Stale or future snapshots return snapshot_unavailable without operation
assessments. Invalid or inconsistent data throws rather than appearing healthy.

## Observation meanings

| Observation | Meaning and permitted response |
| --- | --- |
| due_metadata_requires_review | Stored due metadata is at least the configured age at the snapshot; inspect runner context and current records |
| selected_metadata_without_feedback | Selected metadata is due while the runner is expected to run; inspect dispatch and feedback history |
| unresolved_scheduling_metadata | Prior scheduling outcome was unresolved or settlement review_required; inspect current financial evidence separately |
| backoff_in_progress | Unresolved metadata is cooling down with a positive review-failure count; observe without bypassing cooldowns |

A due resolved row can contribute to due_metadata_requires_review. It is not
proof that a financial job remains eligible. Selected metadata without feedback
does not prove a live, failed or stuck worker. Backoff is expected scheduling
behaviour and does not itself prove an incident.

Paused or unknown operations do not receive due-age or missing-feedback
observations. Unresolved/backoff observations remain visible as context.
An empty observed snapshot is not a financially healthy result.

## Boundaries

Counts use bigint comparisons without converting to JavaScript Number.
Snapshot shape, operation coverage, counts and timestamp consistency are checked.
The due-age calculation uses the snapshot timestamp, not assessment time.
Freshness separately limits how old that snapshot may be.

There is no automatic replay, claim reset, cooldown override, metadata cleanup,
financial-state change or alert delivery. Future delivery requires separate
review of ownership, routing, deduplication, acknowledgement and escalation.
Persistent snapshot failures must be monitored by the eventual caller; errors
must never be substituted with empty snapshots.

Real queue-selector profiling, production load, verified runner activity,
threshold selection, alert transport and housekeeping remain outstanding.
