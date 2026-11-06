# Financial queue scheduling-metadata housekeeping review

Prepared: 21 October 2026.

This stage reports metadata for manual review. It contains no deletion code,
retention policy, cleanup worker, API, scheduler or provider integration.
Every result explicitly states deletionAuthorized: false.

## Why age is insufficient

Queue rows preserve cooldowns, failure history and, for four queue families,
feedback tokens. Removing a row can make a financial record appear unreviewed,
remove backoff and prevent older feedback from matching its scheduling row.
This remains true when a financial worker has already committed its outcome.

The settlement queue records eligible/review_required outcomes and does not
use feedback tokens. Eligible is not proof of financial completion.

## Report semantics

The caller supplies an explicit review-before timestamp, which cannot be later
than the database snapshot. It is a review filter, not an approved retention
period. No default cutoff is selected.

| Field | Meaning |
| --- | --- |
| total | Stored scheduling rows |
| missingSource | Referenced local financial row is absent in the same snapshot |
| missingSourceCooling | Missing-source rows whose cooldown remains in the future |
| selected | Rows retaining a selected scheduling outcome |
| unresolved | unresolved or settlement review_required outcomes |
| cooling | All rows with a future next-review time |
| oldMissingSourceForReview | Missing source, reviewed strictly before the supplied cutoff, cooldown elapsed, and last scheduling outcome resolved or eligible |

Categories overlap. They must not be summed as disjoint buckets.
oldMissingSourceForReview identifies observations only; it never authorizes
deletion. Existing-source metadata is excluded from that review category,
regardless of its age or scheduling outcome.

All ten operations use one repeatable-read, read-only snapshot. Counts are
decimal strings. The report exposes no financial record IDs, feedback tokens,
provider references, personal data or financial amounts.

## Concurrency and future cleanup boundaries

Source existence is true only at the report snapshot. A later insertion,
restoration, import or queue review can change the interpretation.
A future cleanup executor would need a separately reviewed policy, fresh
checks, scheduling lock coordination and token/version checks where applicable.
Queue advisory locks coordinate queue bookkeeping, not every financial write.

Selected, unresolved, cooling or source-present metadata must not be treated
as removable merely because it is old. Never reset financial ownership,
change financial statuses, shorten cooldowns or use cleanup as a retry method.
Financial evidence, audits and provider references remain outside cleanup scope.

## Performance and operations

The report scans scheduling metadata and probes financial-row existence.
Output bounds do not bound SQL work. A two-second lock timeout and five-second
statement timeout apply per statement, not as a hard overall deadline.
Normal PostgreSQL access-share locks still apply.

Missing schemas and query failures fail visibly rather than reporting no work.
No financial worker or provider is invoked. Cleanup execution, retention
decisions, load profiling and production approval remain separate work.
