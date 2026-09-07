# Batch 10F — Account security controls

## Included

- A server-side registry for every new authenticated session.
- Immediate rejection of expired or revoked sessions on protected API routes.
- A customer-facing count of active sessions.
- A **Sign out other devices** control that preserves the current session.
- Security-event recording when other sessions are revoked.
- Database groundwork for WebAuthn passkeys. HOST stores public credentials only; an authenticator retains each private key.

## Expected installation behaviour

Migration `018_account_security.sql` creates the new security tables. Existing JWTs pre-date the session registry and will be asked to sign in again once. This is deliberate and does not affect profiles, bookings, payments, messages, or property data.

## Next security increment

- WebAuthn registration and authentication ceremonies.
- MFA recovery codes and step-up authentication for high-risk actions.
- Privacy self-service: export, closure request, retention and anonymisation workflow.
- Administrator alerts, backup restoration testing and independent penetration testing before launch.

