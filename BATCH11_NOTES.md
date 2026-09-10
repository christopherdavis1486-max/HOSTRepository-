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

## Acceptance closure - 10 September 2026

Batch 11 staging acceptance is complete.

- Verified that unapproved properties cannot be published.
- Verified owner draft, submission, administrator review, request-changes,
  correction, resubmission and approval states.
- Verified that administrator decisions require notes and are audited.
- Verified publishing succeeds only after compliance approval.
- Verified the public listing shows the aggregate review statement and five
  applicable checks without exposing evidence links or internal notes.
- Verified the controlled acceptance listing was returned to Paused.
- Fixed partial drafts incorrectly requiring HTTPS evidence for untouched items.
- Fixed approved properties displaying incomplete-compliance instructions.
- Fixed the administrator review note repeating beneath every compliance item.
- Added an automated partial-draft regression test.
- Production build, type checking and linting passed.
- Production UI regression checks passed after deployment of commit 8823431.
- Batch 11 Compliance Acceptance remains Paused.
- Batch 11 Partial Draft Regression remains Draft and non-public.

Production onboarding remains blocked until the evidence-link workflow is
replaced with authenticated private-object storage and HOST's solicitor has
reviewed the final compliance wording and country-specific requirements.
