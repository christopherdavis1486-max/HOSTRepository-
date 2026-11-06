# Monitoring email occurrence and attempt tracking

Prepared: 24 October 2026.
Status: implementation design; delivery remains disabled.

## Scope

Keep monitoring history records unchanged. Store delivery tracking in a
separate trusted local directory, never inside the monitoring chain.
The monitoring chain rejects additional files.
No provider calls, retries or automatic recovery are introduced by this design.

## Condition occurrence

Identify an occurrence using the bound source identity, a chain identifier,
the condition key and the committed record hash where that occurrence opened.
Use a versioned canonical encoding before hashing those components.
The chain identifier must be stable across restarts and checked against its
configured chain; a directory path alone is not a portable chain identity.
Continuing and unconfirmed transitions retain the occurrence.
A confirmed clearing closes it. A later opening creates a new occurrence.

Read committed records only after source-chain validation with writers stopped
or equivalent coordination. Do not attach an attempt to an unpublished record.
A snapshot's missing key alone must not authorise a clearing notification.
Confirmed clearing must be established through validated retention evidence.
If the required transition cannot be reconstructed, block clearing delivery.

## Delivery eligibility

Opening email candidates are warning-severity openings.
Information findings stay in reports. Continuing conditions have no reminders.
Unconfirmed conditions remain pending and never imply recovery.
Clearing email candidates require a validated cleared transition and recorded
opening acceptance for the same occurrence, recipient and channel.
An acceptance for another recipient or an earlier occurrence is insufficient.

## Attempt lifecycle

Persist an immutable attempt intent before calling an injected sender.
Bind it to occurrence, transition record hash, opening or clearing kind,
recipient, channel and a digest of the exact message content.
Use one coordinated owner when checking eligibility and recording attempts.
Concurrent callers must not both send the same eligible notification.

Persist the outcome separately: accepted with provider message id,
explicitly rejected, or uncertain.
Provider acceptance is not inbox delivery or operator acknowledgement.
A crash after intent but before outcome leaves an unresolved attempt.
That unresolved attempt must block automatic resend, including after restart.
A crash after acceptance but before outcome persistence is also unresolved.
Do not promise exactly-once delivery across the local filesystem and provider.
Rejected and uncertain attempts are visible for review; no automatic retries.

## Provider integration

The current sendEmail wrapper throws for explicit rejection and network errors.
The injected attempt adapter conservatively classifies these throws as uncertain.
Preserving explicit rejection through a real adapter requires structured
provider outcomes; error-message text must not be used to infer certainty.
Raw provider errors and credentials must not enter stored operator summaries.

## Required validation before activation

- Same occurrence continues through unavailable evidence.
- Reopening after confirmed clearing receives a different occurrence id.
- Wrong chain, identity, recipient or occurrence cannot reuse acceptance.
- Clearing without validated evidence or opening acceptance is blocked.
- Intent is stored before a mocked sender runs.
- Unresolved intent blocks resend after a fresh process starts.
- Concurrent attempts cannot both invoke the sender.
- Outcome persistence failure leaves visible uncertainty and blocks retry.

These are planned checks, not completed validation results.
Mailbox ownership and provider sender configuration remain unverified.
Intended recipient is recorded in the separate email decisions JSON.
No operational delivery, database access, financial workers, environment
changes, scheduling or deployment.
