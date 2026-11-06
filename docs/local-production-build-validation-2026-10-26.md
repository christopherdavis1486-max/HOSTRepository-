# Local production build validation - 26 October 2026

## Build
- Created an isolated build copy from tracked and checkpointed working files.
- Environment files were excluded; installed node_modules was linked from the repository.
- Existing repository .next output and normal Git staging were preserved.
- Build ran with loopback host_test configured, all twelve ENABLE_* flags false,
  placeholder Stripe credentials and an empty Resend key.
- Physical network adapters were reported disconnected before the build.
  VPN and virtual-network connectivity was not independently verified.
- Next.js 15.5.28 compiled successfully and generated 83 of 83 static pages.
- The isolated production server started on 127.0.0.1:3000.

## Browser and security observation
- The sign-in page displayed "Sign-in is temporarily unavailable."
- Existing browser cookies produced NextAuth JWT decryption errors after the
  isolated server used a different session secret.
- A private-window sign-in attempt also failed.
- A credential-free local POST to the credentials callback returned HTTP 503
  with SECURITY_NOT_CONFIGURED.
- Production middleware requires the distributed Upstash rate limiter and
  fails closed when it is absent. The isolated launcher omitted its credentials.
- The response is consistent with the intended fail-closed policy; it does not
  establish whether authenticated sign-in works with a configured limiter.
- The server was stopped after the check.

## Limits
- Authenticated production-build browser smoke testing remains incomplete.
- A suitable local mock limiter may enable a later test without changing the
  production security policy or making an external Upstash request.
- Successful Stripe onboarding and fresh-host publication remain unverified.
- The Vercel bundled Zod assessment remains open.
- No deployment, migration, financial activation, environment-file change or
  commit was performed. No real Stripe or email request was submitted.
