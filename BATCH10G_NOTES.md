# Batch 10G — Passkey authentication

## Included

- WebAuthn/passkey registration from the authenticated Account security panel.
- Passwordless passkey sign-in using Windows Hello, a phone, password manager or hardware security key.
- Five-minute, single-use WebAuthn challenges.
- Sixty-second, single-use hashed grants connecting a verified WebAuthn ceremony to NextAuth.
- Required authenticator user verification (device PIN, biometric or equivalent).
- Replay-counter updates and security-event records.
- The server stores only public credentials. Private passkey material remains with the user's authenticator.

## Production configuration

Set `AUTH_WEBAUTHN_ORIGIN` to the exact HTTPS application origin, for example `https://host.example`. The application refuses to start a passkey ceremony in production without this setting. Local development defaults to `http://localhost:3000`.

## Next security increment

- Recovery codes and step-up authentication for sensitive actions.
- Passkey naming/removal and safeguards against removing the final sign-in method.
- Privacy export, account closure, retention and anonymisation workflow.
