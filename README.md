# HOST booking & payments backend

Real Next.js + PostgreSQL + Stripe Connect source code — booking creation,
double-booking prevention, cancellation, refunds, and host payouts. Same
standard as `host-atlas-backend`: type-checked against the actual Stripe
SDK's types (`tsc --noEmit` passes clean, and caught two real bugs before
this shipped — a loose string type on a refund reason, and a stale Stripe
API version literal), not just written to look plausible.

Like the Atlas package, **this has not run against a live database or a
live Stripe test account from this environment** — there's no way to do
that from here. What's verified: the schema is internally consistent, the
TypeScript compiles against real dependency types, and the transaction
logic follows the pattern documented in the main technical spec. What's
not verified: an actual `EXPLAIN ANALYZE`, an actual webhook round-trip,
an actual double-booking race under real concurrent load.

## What's included

```
migrations/
  001_core_schema.sql              users, host_profiles, guest_profiles, verifications
  002_availability_policies_fees.sql  properties columns, availability_blocks, cancellation_policies, fee_configs
  003_bookings.sql                  bookings, booking_guests, booking_price_components
  004_payments_ledger.sql           payments, refunds, payouts, disputes, ledger_entries, audit_log
  005_auth.sql                      admin_roles, email index
  006_messaging_reviews_notifications.sql  conversations, messages, reviews, notifications, notification_preferences
  007_rbac_permissions.sql          admin_role_permissions — the finished RBAC grant table
lib/
  db/index.ts                       Pool + withTransaction() helper
  auth/
    authOptions.ts                  NextAuth config — credentials + optional Google, role resolution
    session.ts                      requireSession() / requireRole() / requireAdminRole()
    permissions.ts                  requirePermission(resource, action) — the FINISHED granular RBAC
    bookingAccess.ts                Shared guest/host/admin ownership check (used by cancel, payment, messaging)
    types.d.ts                      Session/JWT type augmentation
  validation/schemas.ts             Zod schema for every route's input
  booking/                          (unchanged from last version — pricing, cancellation, createBooking)
  payments/                         (unchanged — Stripe Connect, webhooks, refunds)
  hosts/onboarding.ts                Now includes ensureHostProfile() — derives from session, not a client-supplied ID
  payouts/releasePayouts.ts
  messaging/
    types.ts
    conversations.ts                getOrCreateConversation, sendMessage, listMessages, markConversationRead, getUnreadCount
    systemMessages.ts               "Your booking is confirmed.", cancellation notices — the automated messages
  reviews/createReview.ts           Booking-gated review creation, host replies, property rating recalculation
  notifications/
    templates.ts                    Single source of truth for every notification's wording (in-app AND email)
    emailProvider.ts                Resend wrapper — throws clearly if unconfigured, never fakes success
    sendNotification.ts             Central dispatcher — checks preferences, records the attempt, sends
    scheduledNotifications.ts       Check-in reminders + review requests (needs a scheduler — see below)
  seo/metadata.ts                   Property/destination title, description, OG, schema.org JSON-LD generation
app/
  sitemap.xml/route.ts              Dynamic, generated from real published-property data
  robots.txt/route.ts
  api/
    auth/[...nextauth]/route.ts, auth/register/route.ts
    bookings/route.ts, bookings/[id]/cancel/route.ts
    bookings/[id]/messages/route.ts        GET/POST — booking-linked conversation
    bookings/[id]/messages/read/route.ts   POST — mark read
    payments/intent/route.ts, webhooks/stripe/route.ts
    hosts/onboarding/connect-account/route.ts, hosts/onboarding/status/route.ts
    reviews/route.ts                        POST — create (booking-gated)
    reviews/[id]/reply/route.ts             POST — host reply
    properties/[id]/reviews/route.ts        GET — public
    notifications/preferences/route.ts      GET/PATCH
    notifications/unread-count/route.ts     GET
    admin/refunds/route.ts                  Now uses requirePermission("refunds","write")
middleware.ts                        X-Robots-Tag: noindex on every /api/admin/* response
scripts/seedFeeConfig.ts
```

## Messaging

One conversation per booking (`conversations.booking_id` is `UNIQUE`) —
this isn't a general DM system, every conversation exists because a
booking exists, matching the "booking-linked conversations" requirement.
`sendSystemMessage()` posts automated messages ("Your booking is
confirmed.", "Your stay begins tomorrow.", "How was your stay?") into the
conversation *and* fires the matching email, from one shared template in
`notifications/templates.ts` — the wording can't drift between what a
guest sees in-conversation versus in their inbox.

**Attachments are schema-ready, not built.** `messages.attachment_url`
exists and the send-message route accepts one, but there's no upload
pipeline behind it (same gap as property images, flagged in the earlier
audit) — a URL has to come from somewhere else for now.

## Reviews

Booking-gated: `createReview()` checks the booking belongs to the
requesting guest AND has `status = 'completed'` before allowing a review
to exist at all — there's no path to a review for a stay that didn't
happen. `status = 'completed'` is set by
`completeStaysAndRequestReviews()` (see Scheduled jobs below), never by
the guest or host directly. Property `rating`/`review_count` recalculate
automatically inside the same transaction as review creation, so they
never drift out of sync with the underlying reviews.

## Notifications & email

`notifyUser()` is the one function every trigger point calls — the
payment webhook, cancellation, new messages, the scheduled jobs. It
always writes an in-app record (for a future notifications inbox
regardless of channel preference), and additionally sends email if the
user's `notification_preferences` allow it (defaulting to opted-in until
a preferences row exists). **A failed email send is recorded, not
thrown** — a Resend outage shouldn't fail the payment webhook transaction
that triggered it.

`emailProvider.ts` throws immediately if `RESEND_API_KEY` isn't set,
rather than silently no-op-ing — consistent with this project's standing
rule against fake success states.

## RBAC — finished

The previous version's `requireAdminRole(["super_admin","finance"])` on
the refund route was a coarse, hard-coded check. `lib/auth/permissions.ts`
replaces it with `requirePermission("refunds", "write")`, backed by the
`admin_role_permissions` table (migration 007) — granting a new role
refund access is now a data change (`INSERT INTO admin_role_permissions`),
not a code change. `super_admin` bypasses the table (full access by
design); every other role's permissions are explicit grants only, seeded
with a reasonable starting matrix (finance handles refunds/payouts,
operations handles bookings/properties, support is read-only, content
handles properties/reviews).

## SEO

`lib/seo/metadata.ts` generates title/description/canonical/OG/JSON-LD
(schema.org `LodgingBusiness`, the type Google's own docs recommend for
accommodation listings) from property data — this is what a real
frontend's page-rendering code would call per property/destination page.
`sitemap.xml` and `robots.txt` are dynamic routes here because they need
live published-property data, not static files. The actual
crawler-facing protection on `/api/admin/*` is the `X-Robots-Tag` header
in `middleware.ts`, not the `robots.txt` disallow line — a disallow entry
is itself publicly visible and advertises the path exists.

## Scheduled jobs — still need a real scheduler

Three functions now exist that nothing calls on a schedule yet (same gap
as `releasePayouts.ts` from the previous version):
- `releaseExpiredHold()` — pending_payment bookings past their hold
- `releaseDuePayouts()` — payouts past their scheduled release
- `sendCheckinReminders()` / `completeStaysAndRequestReviews()` — the two
  new ones this round

All four need a cron trigger (Vercel Cron, a queue worker, whatever
HOST's real infrastructure ends up using) calling them daily/hourly. None
of them are wired to one — that's real remaining work, not an oversight.



## Authentication — what changed

Every route in the previous version of this package trusted an ID
(`guestId`, `hostProfileId`, `adminUserId`) passed directly in the request
body — flagged explicitly in `HOST_DEVELOPMENT_AUDIT.md` as the largest
gap in the project. That's fixed now:

- **NextAuth** (credentials provider with bcrypt password hashing, plus
  optional Google OAuth if `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` are
  set) issues a JWT session carrying the user's id and resolved roles.
- **Roles are derived, not stored on one column.** A user is a `guest`
  by default the moment they're signed in; they're additionally a `host`
  if a `host_profiles` row exists for them, and additionally an `admin`
  if an `admin_roles` row exists. One person can hold more than one role.
- **Every route now calls `requireSession()`, `requireRole()`, or
  `requireAdminRole()`** from `lib/auth/session.ts` before doing anything
  else, and uses `session.user.id` instead of anything from the request
  body for identity.
- **Ownership checks, not just "is signed in."** Cancelling a booking now
  checks the session user is actually the guest on that booking, the host
  who owns the property, or an admin — the old version would let any
  signed-in guest cancel *any* booking by guessing an ID and setting
  `cancelledBy: "admin"` in the request body. Same fix applied to the
  payment intent route.
- **The admin refund route is gated to the `super_admin`/`finance` admin
  sub-roles specifically**, not just "any admin" — matches the granular
  permissions the main technical spec calls for in §8a. To actually grant
  someone an admin role, insert a row into `admin_roles` directly (no
  self-service admin promotion exists, deliberately).

**Still not done:** email verification (registration creates an account
immediately; `email_verified_at` stays null until an email provider is
connected — audit's P1 item #10), password reset, and MFA. These are
real gaps, not oversights — flagged so they don't get assumed complete.

## Input validation — what changed

Every route now parses its body/params through a Zod schema in
`lib/validation/schemas.ts` before touching any business logic. A failed
validation returns a 400 with a specific, safe-to-display message (field
name + what was wrong) rather than either silently accepting bad input
or leaking an internal error. This was flagged as a gap in the previous
session — Zod was chosen because it's the natural pairing with Next.js
and TypeScript, and schema failures produce typed, structured errors
rather than string-parsing a generic exception.



## The double-booking guard, specifically

`lib/booking/createBooking.ts` is the file that matters most here. The
sequence: lock the date range with `SELECT ... FOR UPDATE` (plus a
Postgres advisory lock keyed on property+dates, to close the gap where no
`availability_blocks` row exists yet to lock), check nothing in range is
already booked, flip the rows to `'booked'`, insert the booking — all in
one transaction. A concurrent second request for the same dates blocks on
the lock until the first commits, then sees `status != 'available'` and
fails cleanly. This is the same logic the technical spec's §5 describes,
now as actual executable code rather than a diagram.

I have not been able to run a real concurrent-load test against this —
that requires a live database and multiple simultaneous connections,
neither of which this environment can provide. Before trusting this in
production, run an actual test: fire two concurrent `POST /api/bookings`
requests for the same property/dates against a real running instance and
confirm exactly one succeeds.

## Local setup

1. **A Postgres provider that supports the PostGIS extension** — Neon,
   Supabase, or local Docker all do (same as the Atlas package's README).
   You don't need to enable PostGIS yourself: `npm run migrate` now runs
   `migrations/000_bootstrap_extensions.sql` first, which enables it
   automatically via `CREATE EXTENSION IF NOT EXISTS postgis` — safe to
   run against a fresh database or one that already has it (production
   already does; this is a no-op there, not a reinstallation).
2. `npm install`
3. `cp .env.example .env.local` and fill in `DATABASE_URL` and Stripe test
   keys from https://dashboard.stripe.com/test/apikeys
4. `npm run migrate`
5. `npm run seed` — creates the fee config and standard cancellation
   policies bookings depend on
6. For webhooks locally, use the Stripe CLI: `stripe listen --forward-to
   localhost:3000/api/webhooks/stripe` — this prints a webhook signing
   secret to put in `STRIPE_WEBHOOK_SECRET`
7. `npm run dev`

## Combining with the Atlas package

Both packages are meant to run against the **same database**. Run Atlas's
migrations first (it defines `properties`), then this package's — migration
002 here uses `CREATE TABLE IF NOT EXISTS` for `properties` (so it doesn't
fail if Atlas already created it) and `ALTER TABLE ... ADD COLUMN IF NOT
EXISTS` for the columns Atlas didn't need but booking does (`cleaning_fee`,
`min_stay_nights`, etc.). Run in either order and the result should be the
same combined schema either way.

## Testing the full lifecycle (mirrors the technical spec's §32)

With a real database and Stripe test mode connected:

1. `POST /api/bookings` with an `Idempotency-Key` header → confirm a
   `pending_payment` booking is created and `availability_blocks` rows
   flip to `'booked'`
2. Repeat the exact same request (same idempotency key) → confirm it
   returns the *same* booking, not a second one
3. `POST /api/payments/intent` with that booking's id → get a
   `clientSecret`, confirm the PaymentIntent with a Stripe test card
   client-side
4. Confirm the booking stays `pending_payment` until the webhook fires —
   kill `stripe listen` momentarily to prove this if you want to see it
   directly
5. `POST /api/bookings/:id/cancel` → confirm a refund is requested, but
   the booking's `payment_status` doesn't flip to `refunded` until
   `charge.refunded` arrives
6. Check `ledger_entries` for that booking — accommodation + cleaning +
   fee + tax should sum to the guest charge; host payout should equal
   accommodation + cleaning − commission

## Known gaps — explicitly not built here

- **Email verification, password reset, MFA.** Real auth now exists, but
  these three specifically don't yet — see the Authentication section
  above.
- **The expired-hold sweep.** `releaseExpiredHold()` exists as a function
  but nothing calls it on a schedule yet — needs a cron trigger calling it
  for `pending_payment` bookings past `hold_expires_at`.
- **Rate limiting** on the public routes — registration and login
  specifically are brute-forceable as-is.
- **Refund-reason-to-fee-refundability mapping** — right now a "full
  refund" tier refunds the entire `guest_total_minor` including the
  service fee. Whether the guest service fee should actually be
  refundable is a commercial decision the technical spec flags as open,
  not something this code has quietly decided.
- **Separate-charges-vs-destination-charges** for payout timing — this
  package uses destination charges (funds move to the host near
  immediately at charge time); `releasePayouts.ts` has a marked `TODO`
  for the alternative if HOST wants payout timing fully decoupled from
  Stripe's default behavior.

## Trip history, favourites, and password reset — this round's additions

- **`GET /api/bookings`** — didn't exist before; there was no way to even list a signed-in guest's bookings. Excludes archived trips by default.
- **`POST /api/bookings/:id/archive`** — "Remove from My Trips." Only ever sets `archived_at`; nothing in this codebase has a path to actually deleting a booking row. Restricted to `cancelled`/`completed`/`refunded` bookings — an active booking can't be hidden.
- **Favourites** (`/api/favourites`) — save/unsave/list. Duplicate-save prevention is the `(user_id, property_id)` primary key itself, not an application-level check that could race.
- **Password reset** (`/api/auth/password-reset/request` + `/confirm`) — token is emailed raw but only its SHA-256 hash is ever stored, expires in 30 minutes, and using one reset link invalidates any other outstanding ones for that user. Both routes return the same response shape regardless of whether the email matched an account, for the same account-enumeration reasoning as registration.



1. `POST /api/auth/register` with a weak password (e.g. `"password"`) →
   confirm it's rejected with a specific Zod message, not a generic 400
2. Register properly, then try `POST /api/bookings` **without** signing
   in → confirm 401, not a booking created with a null guest
3. Sign in as guest A, note a booking ID belonging to guest B → attempt
   `POST /api/bookings/:id/cancel` on it → confirm 403
4. Manually insert an `admin_roles` row with `role='support'` (not
   `finance`) for a test user → confirm `POST /api/admin/refunds` still
   403s for them → change the role to `finance` → confirm it now works

