# HOST Batch 12D — multilingual account and authentication

## Included

- Six-language sign-in, registration, passkey and recovery-code interface.
- Six-language forgot-password, reset-password and email-verification screens.
- Six-language saved-stays/favourites page.
- Localised account loading, profile, notification preferences, quick links, section headings and sign-out controls.
- All Batch 12C language, calendar, pluralisation and DST fixes.

## Security boundaries

- Authentication, passkey, password, privacy and deletion API behaviour is unchanged.
- Backend validation and provider/device messages remain verbatim so the client cannot weaken or misstate a security result.
- Detailed retention/deletion explanations and binding legal terms remain authoritative English.

## Database

No new migration is required.

## Verification

- TypeScript validation passes.
- Next.js production build passes with 59/59 pages generated.
