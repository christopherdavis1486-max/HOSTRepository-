# HOST Batch 14A - Pilot onboarding readiness audit

## Objective

Define and verify the complete journey required to onboard HOST's first 5-10 pilot properties without enabling live financial execution.

## Starting point

- Batch 13B staging acceptance is formally closed.
- Production deployment is stable.
- Stripe remains in test mode.
- One connected test host and approved test property exist.
- Guest booking, messaging, cancellation and refund flows are verified.
- Saved stays and host workspace navigation are available.

## Workstreams

### 1. Host entry and onboarding

- Verify how a guest account becomes a host.
- Verify host-role assignment and host profile creation.
- Verify Stripe Connect onboarding, refresh and return flows.
- Provide clear onboarding progress and recovery states.
- Ensure users cannot create duplicate connected accounts.

### 2. Property creation

- Audit the new-property form and API.
- Confirm required identity, location, description, capacity and pricing fields.
- Confirm amenities, house rules, check-in instructions and cancellation policy.
- Confirm draft saving and validation behaviour.
- Confirm ownership isolation for every property mutation.

### 3. Property media

- Determine the current image-storage implementation.
- Add a safe property-photo upload and ordering workflow if missing.
- Define image type, size, count and moderation constraints.
- Require a usable cover image before publication.

### 4. Availability and pricing

- Verify calendar blocking and reopening.
- Verify nightly price and fee configuration.
- Prevent overlapping confirmed or pending reservations.
- Confirm timezone and date-boundary behaviour.

### 5. Compliance and publication

- Verify Draft -> Submitted -> Approved -> Published -> Paused transitions.
- Ensure hosts cannot self-approve compliance.
- Ensure incomplete, rejected or expired compliance blocks publication.
- Provide actionable host-facing status guidance.

### 6. Pilot operations

- Define the internal onboarding checklist for each property.
- Define manual review and escalation points.
- Record test-host and test-property cleanup rules.
- Prepare acceptance evidence for the first 5-10 pilot properties.

## Safety constraints

- Stripe test mode only.
- Delayed charging disabled.
- Automated off-session charging disabled.
- Host-transfer execution disabled.
- No public pilot traffic during 14A.
- No live host payout onboarding until the financial model is approved.
- Stripe Funds Segregation remains under review.
- No secrets, identity documents or webhook values are committed or pasted into test records.

## 14A deliverables

- Current-capability inventory.
- Gap and risk register.
- Prioritised Batch 14B implementation list.
- Batch 14C acceptance checklist.
- Explicit go/no-go conditions for pilot onboarding.

## Exit criteria

Batch 14A closes only when every onboarding step has an identified page, API, owner, validation rule, access-control rule and acceptance test.

## Verified capability inventory

### Host onboarding

- Any authenticated user may create one host profile through the Stripe onboarding API.
- Existing Stripe accounts are reused, preventing routine duplicate account creation.
- Stripe readiness is checked directly and requires the recipient transfer capability to be active.
- Existing hosts can start or resume Stripe setup from the host dashboard.
- The Account page's Become a host link incorrectly uses /hosts/onboarding/connect-account; the real route is /host/onboarding/connect-account.
- Roles are resolved only at sign-in. Creating a host profile does not refresh the current JWT, so a newly created host can retain a guest-only session until signing in again.
- Successful onboarding returns Continue to the homepage instead of the host dashboard.
- Host country accepts any two-character value while the implementation remains GB/GBP and individual-only.
- Company hosts, host agreements and structured onboarding progress are not supported.
- Stripe Accounts v2 remains private-preview dependent.

### Property creation and management

- Hosts can create and edit draft properties with name, type, description, city, district, country, capacity, bedrooms, bathrooms, base price, cleaning fee, arrival times, house rules and amenities.
- Property reads and mutations enforce authentication and ownership isolation.
- The database already supports public/private coordinates, minimum/maximum stays and cancellation-policy assignment.
- The host interface does not expose those existing settings.
- Exact postal address fields, image records and a photo-upload pipeline do not exist.
- Bed configuration and arrival instructions are not captured.

### Availability and pricing

- Hosts can block and unblock date ranges.
- Guest-booked dates are distinguished from host blocks and cannot be removed by the host unblock operation.
- Booking creation uses a property-level advisory lock to prevent overlapping concurrent bookings.
- Host availability changes are not transactionally serialized with booking creation, leaving a concurrency race.
- Availability validation checks only YYYY-MM-DD text ordering; it does not reject impossible dates, past dates or excessive ranges.
- Availability changes execute sequential queries for every date.
- Booking totals use the base nightly price. Date-specific price overrides are not used.

### Compliance and publication

- Compliance approval is controlled separately from the host property editor.
- Publication is blocked when compliance is not approved or required evidence has expired.
- Publication does not currently require payout readiness, images, exact location, cancellation-policy selection, stay limits, complete descriptive content or host agreement acceptance.
- A missing cancellation policy silently falls back to the built-in 120-hour/24-hour refund schedule.
- A compliant but commercially incomplete listing can therefore be published and booked.

## Initial risk register

### Launch blockers

1. Repair the Become a host route.
2. Refresh host role/session state immediately after host-profile creation.
3. Replace the compliance-only publication check with a consolidated listing-readiness gate.
4. Add property image storage, secure upload, ordering and cover-image selection.
5. Add exact private address/location capture with privacy-safe public location.
6. Expose and require cancellation policy and stay limits.
7. Make availability mutations bounded, valid and concurrency-safe.

### Required pilot controls

- Restrict host onboarding to GB until multi-country settlement is deliberately supported.
- Present and record host agreement and default-policy acceptance.
- Keep payout execution and all deferred/off-session financial automation disabled.
- Require manual HOST review before each pilot listing is published.
- Direct completed hosts to the host dashboard with clear next steps.

### Later improvements

- Company-host onboarding.
- Multi-country currency and settlement.
- Seasonal and date-specific pricing.
- Calendar synchronisation.
- Detailed bed layouts and richer arrival instructions.

## Additional verified risks

- Cancellation-policy seeding is not idempotent because policies lack a unique stable key; repeated seeding can create duplicates.
- Public and private coordinates exist in the database but have no host write path.
- Private coordinates are correctly excluded from guest-facing responses.
- Sharp is installed for image processing, but no durable image-storage provider exists.
- Existing availability tests cover blocking, unblocking, booking protection and ownership isolation.
- Automated host-onboarding tests are absent.

## Batch 14B implementation order

1. Repair first-time host entry, session refresh and post-onboarding routing.
2. Restrict pilot host onboarding to GB individuals and record host agreement acceptance.
3. Make cancellation-policy seeds idempotent and expose a policy catalogue.
4. Add stay-limit and cancellation-policy controls to property creation and editing.
5. Add private address capture and derive a privacy-safe public map point.
6. Add property image storage, secure upload, ordering and cover-image selection.
7. Add a consolidated server-side listing-readiness gate.
8. Harden availability validation, range limits, bulk operations and booking concurrency.
9. Add onboarding, readiness, media, location and availability tests.
10. Add host progress guidance and an internal pilot-review checklist.
## Batch 14C acceptance checklist

- Become a host works without a 404 or forced re-login.
- Repeated onboarding reuses one Stripe account.
- Unsupported pilot countries and entity types are rejected.
- Address privacy and cross-host media isolation are verified.
- Stay limits and cancellation policy persist and display correctly.
- Availability rejects invalid ranges and cannot overwrite bookings.
- Incomplete listings cannot be published.
- Complete approved listings can be booked in Stripe test mode.
- All financial safeguards remain disabled.
- Build, focused tests and the manual pilot journey pass.
## Pilot go/no-go conditions

### Go

- Every Batch 14C acceptance item passes.
- Each pilot listing is complete, compliance-approved and manually reviewed.
- Stripe remains in test mode and payout execution remains disabled.
- Required legal and accounting decisions are documented.

### No-go

- Host onboarding requires a 404 workaround or forced re-login.
- An incomplete listing can become bookable.
- Media or private location data can cross ownership boundaries.
- Host availability changes can overwrite a genuine booking.
- Cancellation terms are missing, duplicated or undisclosed.
- Any protected financial automation is enabled unintentionally.
## Responsibility map

| Stage | Page | API/service | Owner | Validation and access test |
| --- | --- | --- | --- | --- |
| Become a host | /account | Host onboarding API | Guest | Signed-in GB pilot user; signed-out rejected |
| Stripe setup | /host/onboarding/complete | Stripe onboarding/status | Host | One account per host; other users denied |
| Create and edit | /host/properties/new and /host/properties/[id] | Host property API | Host | Required fields valid; cross-host access denied |
| Location and media | /host/properties/[id] | New location/media APIs | Host | Ownership enforced; private data never public |
| Availability | /host/properties/[id] | Availability API | Host | Valid bounded future dates; bookings protected |
| Compliance | Property and admin compliance pages | Compliance APIs | Host and admin | Host submits; only admin approves |
| Publication | /host/properties/[id] | Listing-readiness service | Host | Server rejects every incomplete listing |
| Pilot approval | Internal checklist | Manual review record | HOST admin | Evidence complete before publication |
