# Batch 10D — Account profile and safe trip cleanup

## What changed

- Account now supports editing a full name and phone number. Email remains read-only because it is the sign-in identity.
- Added authenticated `GET`/`PATCH /api/account/profile` endpoints with server-side validation.
- Added a deliberately narrow **Discard unpaid booking** action for abandoned `pending_payment` bookings.
- The discard transaction refuses any booking with a paid legacy payment, successful delayed charge, or host transfer entitlement; then releases its booking-created availability, soft-archives the booking, and writes an audit entry.
- Cancelled, completed, and refunded bookings can be hidden from My Trips using the existing soft-archive path.
- Confirmed or paid bookings cannot use the cleanup action.

## Database

Run once after copying `.env.local`:

```powershell
npm.cmd run migrate
```

Migration `016_user_profile_fields.sql` adds the nullable `users.full_name` field. The existing `users.phone` field is reused.

## Verification

- Production build: passed
- TypeScript (`tsc --noEmit`): passed
- Focused profile and discard-safety tests: 8 passed

No `.env.local`, Stripe secrets, build output, or dependencies are included in the ZIP.
