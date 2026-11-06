# Setup review digest preview HTTP validation

Date: 2026-11-04

- TypeScript passed for the preview route.
- Next.js served the route on 127.0.0.1:3017. The temporary APP_URL and
  request Origin both matched that address.
- The route returned 401 without a bearer token and 400 for an invalid window.
- Two requests for the same past UTC window produced one mock receipt.
- The disposable host_digest_staging database was removed.
- Validation used a local restore and mock delivery. Deployed scheduling,
  the operational recovery cutoff, and live delivery remain open.
