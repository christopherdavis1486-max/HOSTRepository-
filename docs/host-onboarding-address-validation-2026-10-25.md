# Local onboarding address validation - 25 October 2026

## Fixture and environment
- Fictional hotel: HOST Onboarding Test Hotel 24 October.
- Property ID: b7d31e72-c0a1-406a-b46b-635769e04939.
- Guarded development server used loopback host_test with all twelve feature flags disabled.
- No environment files were edited.

## Browser evidence
- Before editing, screenshot showed the correct hotel and Draft status.
- Existing address: 1 Fictional Test Street, Liverpool, Merseyside, L1 1AA.
- Both coordinate fields were initially blank.
- User saved fixture latitude 53.4073 and longitude -2.9836.
- Subsequent screenshot showed both coordinate values.
- Subsequent authenticated readiness API returned success:true.
- Private address check returned ready:true; overall readiness remained false.
- Remaining blockers: property images, payout account, compliance, pilot review and hotel rooms.
- Read-only loopback host_test inspection confirmed private coordinates 53.4073, -2.9836 and public coordinates 53.41, -2.98.
- Database public_matches_grid returned true. Guest-facing API privacy was not independently retested during this stage.
- Compliance page loaded with status Not started and seven evidence categories.
- No compliance submission or approval was reported.

## Close-out and limitations
- User confirmed the server was stopped.
- Final supplied screenshot showed NextAuth CLIENT_FETCH_ERROR / Failed to fetch.
- This is consistent with a session request after shutdown; exact timing was not established.
- Final database inspection independently confirmed status draft after the save; the read-only inspection changed no rows.
- No publication action was requested.
- Image upload routes use Vercel Blob; uploads remain untested in this walkthrough.
- Stripe onboarding, compliance approval, pilot approval and completed publication remain unverified.
- This source evidence does not back up the fixture database rows.
- No application source changes, deployments, migrations, financial activation or commits were made in this address-validation stage.
