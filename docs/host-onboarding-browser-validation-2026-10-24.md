# Local host onboarding browser validation

Prepared: 24 October 2026.

## Environment and fixture

Local loopback host_test database; development server on port 3000.
The launcher set all twelve financial feature gates to false, supplied a
placeholder Stripe secret key and an empty email-provider key.
Environment files were not edited. Feature gates do not block every
provider call: host Stripe onboarding remains a separate call path.

User: host-onboarding-20261024@example.test.
Property: HOST Onboarding Test Hotel 24 October.
Property ID: b7d31e72-c0a1-406a-b46b-635769e04939.
Slug: host-onboarding-test-hotel-24-october-61ec26.
Fictional local fixture only; property remains draft.
Test Standard Double: three rooms, two guests per room, GBP 100/night,
zero cleaning fee. No property or room photos were uploaded.
These database fixtures are retained; the source checkpoint is not a
database backup and does not reproduce their rows.

## Observed results

Registration and sign-in succeeded. The account page showed the fixture
email. Email delivery and ownership verification were not demonstrated.
Both consent controls were visible; the button appeared disabled with
one checked and enabled with both checked.

An onboarding POST reached Stripe account creation using the placeholder
key and was rejected with StripeAuthenticationError, invalid_v2_key.
This was an actual provider API attempt, not a mocked call or successful
Stripe test-mode acceptance. No account ID was returned.
The route creates/reuses the local host profile and records agreement
acceptance before attempting Stripe account creation.

The existing session initially lacked the host role. After logout and
sign-in, the status endpoint returned success with not_connected.
The inspected service returns this state without Stripe retrieval when
no connected account ID is stored.
The refreshed dashboard loaded with zero bookings and later one property.

The hotel draft and room type saved through the UI.
Publication was rejected for six requirements: private address, property
images, Stripe payout account, property compliance, HOST pilot review
and hotel rooms. Adding a room without a photo did not clear readiness.
The property list continued to show Draft.

The owner could preview the draft using the guest-facing URL.
A cookie-free request to the page returned HTTP 200 because the page is
a client-rendered shell. The cookie-free property API returned HTTP 404
PROPERTY_NOT_FOUND. After logout the browser displayed Stay not found
with Log in and Sign up navigation. No anonymous draft exposure was
established; no visibility code change was made.

## Dashboard guidance change

The forbidden dashboard state now offers Continue host setup and advice
to check the signed-in account. The access restriction remains.
The original dashboard was backed up before editing.
TypeScript and dashboard whitespace checks passed after the change.
The new forbidden-state link was not separately confirmed in the browser
before the fixture acquired host access.

## Development server recovery

A missing generated module error was resolved by stopping the server,
preserving .next as .next-before-restart-20261024-190734329 and restarting.
The homepage then returned HTTP 200. Generated output is excluded from
the source checkpoint.

## Remaining work

Successful Stripe test-mode onboarding, email verification delivery,
full fresh-host compliance/approval/publication, browser checkout and
deployed staging verification remain pending.
The session-refresh behaviour after partial onboarding needs review.
No successful payment, payout, refund or reservation was performed in
this walkthrough. No real compliance evidence was approved.
No deployment, migration, financial activation or commit.
No automated tests or production build rerun during this close-out.
This checkpoint is local development evidence, not launch approval.
