# Batch 11 — Property owner compliance and evidence review

## Delivered

- Seven structured owner declarations covering authority, fire, gas,
  electrical, alarms, insurance, and licences/permissions.
- Per-item applicability, declaration, HTTPS evidence reference, expiry date,
  owner explanation, review status and reviewer note.
- Dedicated host compliance workspace with draft and submit states.
- Passkey-protected admin review queue with approve/request-changes actions.
- Publishing guard: a new or paused listing cannot be published until its
  compliance submission is approved; expired evidence also blocks publishing.
- Existing published properties are queued for review without cancelling or
  disrupting existing bookings.
- Guest-facing wording distinguishes owner responsibility from HOST evidence
  review and never exposes evidence links or internal notes.
- Owner and administrator actions are written to the existing immutable audit
  trail.

## Responsibility boundary

HOST approval records that supplied evidence was reviewed. It is not a safety
certification, guarantee, inspection, or transfer of the property owner's legal
responsibility. Final wording and country-specific requirements must be checked
by HOST's solicitor before production launch.

## Evidence storage

Batch 11 accepts HTTPS links from a controlled document provider. Direct binary
uploads are deliberately not faked: production deployment must connect an
authenticated private-object store with malware scanning, access logs, retention
rules, and expiring download links.
