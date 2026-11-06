# Monitoring email occurrence lifecycle and codec

Prepared: 24 October 2026.

## Implemented

Pure lifecycle tracking uses validated retention transitions.
Continuing and unconfirmed conditions retain their occurrence identifiers.
Confirmed clearing removes the active occurrence; a later opening uses
the new opening record hash to derive a different identifier.
Returned history, findings and occurrence state are detached from inputs.
Duplicate current record hashes and inconsistent active metadata are rejected.

Identity comparison was corrected to ignore property order while retaining
field validation. Originals were backed up before the correction.

A versioned JSON codec embeds bound retained-history evidence and restores
Date objects. It checks expected source and chain identity, record hash
format, occurrence identifiers and correspondence with pending evidence.
Duplicate, missing and malformed occurrences are rejected.
The outer payload is limited to 2 MiB; embedded history retains its own limits.

## Validation

Latest run: ten cases passed, zero failures, skips or cancellations:
five codec cases and five lifecycle cases. TypeScript passed.
An earlier eight-case run combined lifecycle and identifier tests.
These runs overlap and must not be added into a unique test total.
Stage whitespace checked separately; no tests rerun during close-out.
The wider project suite was not rerun.

## Limits and next work

These modules do not read committed chain records or prove membership,
predecessor linkage, historical opening legitimacy or authenticity.
The caller must verify supplied record hashes and that observations produced
the committed snapshot. Codec validation alone does not establish this.
There is no occurrence file storage, durable attempt intent, acceptance
receipt, clearing-delivery eligibility or command/provider integration.
No operational chain identifier is assigned.

Next: immutable occurrence storage and reload validation, followed by
committed-chain verification and durable attempt handling.
Delivery remains disabled. No email, database access, workers, scheduling,
financial activation, environment changes, deployment or commits.
