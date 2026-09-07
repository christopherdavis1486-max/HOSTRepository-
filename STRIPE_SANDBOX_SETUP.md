# HOST — Stripe Sandbox Setup & Smoke Test Procedure

**Status: IMPLEMENTED — PENDING REAL STRIPE SANDBOX VERIFICATION.**
Nothing in this document should be read as "Stripe is verified working." Every piece of logic that *reacts to* Stripe has been tested against genuinely-signed synthetic webhooks in a local sandbox. The literal HTTP calls *to* Stripe (`paymentIntents.create`, `refunds.create`, and the Stripe.js script itself loading from `js.stripe.com`) have never executed, because the preparation environment has no route to Stripe's servers. This document exists to make the *next* step — the first real one — as close to copy-paste as possible.

---

## 1. Environment variables required

```
DATABASE_URL=                          # real Postgres, PostGIS enabled
AUTH_SECRET=                           # openssl rand -base64 32
STRIPE_SECRET_KEY=sk_test_...          # server-side only, never in client code
STRIPE_WEBHOOK_SECRET=whsec_...        # from the Stripe Dashboard webhook config, see §3
NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=pk_test_...   # client-side, safe to expose — this was missing entirely before this pass
APP_URL=https://your-staging-domain
RESEND_API_KEY=                        # optional — notifications degrade gracefully without it
EMAIL_FROM_ADDRESS=
GOOGLE_CLIENT_ID=                      # optional
GOOGLE_CLIENT_SECRET=                  # optional
```

`.env.example` in the package has all of these as placeholders only. Never commit a real value.

**Confirmed by inspection:** the codebase needs exactly these three Stripe-related variables — `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, and (as of this pass) `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY`. That third one didn't exist anywhere in the project until now — the backend has always returned a real `clientSecret`, but nothing client-side could use it without a publishable key to initialize Stripe.js.

---

## 2. What was built this pass, specifically

- **`app/checkout/[bookingId]/page.tsx` + `components/CheckoutForm.tsx`** — a real Stripe Elements checkout, minimal by design (this is a smoke-test fixture, not the final product checkout page). Fetches a real `clientSecret` from the existing `/api/payments/intent` route, mounts Stripe's `<PaymentElement>`, calls `stripe.confirmPayment()`.
- **`app/checkout/[bookingId]/return/page.tsx`** — where Stripe redirects after payment. Deliberately does *not* read Stripe's `redirect_status` query parameter and declare success from it — it polls the real `GET /api/bookings/:id` route instead, so it can only ever show what the webhook has actually confirmed.
- **Rate limiting** (`middleware.ts`) — real, live-tested (5 requests allowed, 6th correctly rejected with `429`), covering auth endpoints (register, password-reset request, credentials sign-in — 5/15min) and financial mutation endpoints (payment intent creation, booking creation, admin refunds — 20/15min). Honest limitation stated directly in the code comments: this is in-memory, correct for a single instance, and needs a shared store (Upstash Redis is the natural choice on Vercel) before a multi-instance production deployment.
- All prior fixes (PaymentIntent idempotency/reuse, refund remaining-balance validation) are untouched — confirmed by re-running `tsc --noEmit` clean after every change in this pass, not just at the end.

**Found in the process, documented not silently fixed:** `npm audit` reports 3 high-severity advisories in `next@15.x`'s transitive dependencies (`postcss`, `sharp`). The fix requires a Next.js 16 major-version upgrade — a breaking change with its own testing surface, not something to apply as a side effect of a Stripe prep pass. Flagged here for a deliberate decision, not bundled in.

---

## 3. Configuring the real Stripe Test Mode webhook

1. **Endpoint URL:** `https://<your-staging-domain>/api/webhooks/stripe`
2. In the [Stripe Dashboard](https://dashboard.stripe.com/test/webhooks) (Test Mode toggle on), add an endpoint with that URL.
3. **Events to subscribe to** (exactly what `webhookHandler.ts` handles — subscribing to more just adds noise):
   - `payment_intent.succeeded`
   - `payment_intent.payment_failed`
   - `charge.refunded`
   - `charge.dispute.created`
   - `account.updated`
4. Stripe generates a **signing secret** (`whsec_...`) for that specific endpoint — copy it into `STRIPE_WEBHOOK_SECRET`. This is endpoint-specific; it is *not* the same as any secret used in earlier local synthetic testing (those used a placeholder value, `whsec_test_placeholder`, which will never validate against a real Stripe-signed event — this is actually a useful property: it's structurally impossible to confuse a synthetic test payload with a genuine one, since they'd need the same secret to both validate).

### Verifying Stripe is actually reaching HOST
- Stripe's Dashboard → your webhook endpoint → **"Recent events"** tab shows every delivery attempt and HTTP response code HOST returned. A `200` here is the first real proof of connectivity.
- Server-side, every processed event logs through the existing `console.error`/handler logic — for a genuine success you should see no `[HOST webhooks/stripe]` error lines at all (that logger only fires on failure).
- **Distinguishing genuine from synthetic:** a genuine webhook's signature will only verify against the real `STRIPE_WEBHOOK_SECRET` from step 4 above. Nothing in this codebase can produce a validly-signed event without knowing that secret, and the secret is Stripe's own, generated server-side in their dashboard — there's no code path here that fabricates a "genuine-looking" event.

### Local-to-staging bridging (optional, before a public domain exists)
If you want to test webhook delivery before staging has a real public URL, the [Stripe CLI](https://stripe.com/docs/stripe-cli)'s `stripe listen --forward-to localhost:3000/api/webhooks/stripe` is Stripe's own documented approach — it genuinely calls Stripe's servers and forwards real events to a local port. This still requires outbound access to Stripe from wherever `stripe listen` runs, so it doesn't help from *this* preparation environment, but it's the right tool once you're somewhere with connectivity.

---

## 4. The smoke test procedure

Run these **in order** — later tests depend on earlier ones. Use only Stripe's own documented test cards, never a real card, ever, even in Test Mode.

### TEST A — Successful payment
1. Sign in as a test guest account.
2. `POST /api/bookings` with a real property, real dates → note the returned `booking.id`.
3. Open `/checkout/<booking.id>` in a browser.
4. Enter Stripe's standard success test card: **`4242 4242 4242 4242`**, any future expiry, any 3-digit CVC, any postal code.
5. Submit.
6. Confirm the Stripe Dashboard (Test Mode → Payments) shows a succeeded PaymentIntent.
7. Confirm the Dashboard's webhook "Recent events" shows a `200` delivery for `payment_intent.succeeded`.
8. Confirm `GET /api/bookings/<id>` now returns `status: "confirmed"`.
9. Confirm the return page (`/checkout/<id>/return`) shows "Booking confirmed" — it's polling the same endpoint, so this and step 8 should agree.
10. Query Postgres directly: `SELECT type, amount_minor, status FROM ledger_entries WHERE booking_id = '<id>'` — expect 8 rows with the same structure verified in the local synthetic test.

### TEST B — Payment failure
Use Stripe's documented decline card: **`4000 0000 0000 0002`**. Confirm:
- The Dashboard shows a failed PaymentIntent.
- `booking.status` remains `pending_payment`, never `confirmed`.
- `GET /api/notifications` (or the `notifications` table directly) shows a `payment_failed` entry for the guest.
- The checkout form surfaces a real, specific error message (Stripe's own decline message via `stripe.confirmPayment`'s returned `error.message`), not a generic failure.

### TEST C — Duplicate/retry
1. Open the same booking's checkout twice (two tabs, or refresh mid-flow before completing).
2. Confirm via the Stripe Dashboard that only **one** PaymentIntent object exists for this booking — this directly exercises the reuse logic added in the prior pass (`createPaymentIntent.ts` checks for an existing usable intent before creating a new one).
3. Complete payment in one tab. Confirm the booking confirms exactly once — check `ledger_entries` doesn't have duplicate rows.

### TEST D — Refund
1. Using the confirmed booking from Test A, call `POST /api/bookings/<id>/cancel` as the guest (or `POST /api/admin/refunds` as an admin).
2. Confirm the Stripe Dashboard shows a succeeded Test Mode refund.
3. Confirm the webhook "Recent events" shows a `200` for `charge.refunded`.
4. Confirm `booking.status` becomes `refunded` and `payments.status` becomes `refunded`.

### TEST E — Duplicate refund
Immediately attempt another refund on the same now-fully-refunded booking. Confirm it's rejected with `ALREADY_FULLY_REFUNDED` or `NO_ELIGIBLE_PAYMENT` — this exact rejection logic was live-verified against synthetic data in the prior pass (three scenarios: over-request, exact-remaining, already-refunded), so this test is specifically confirming the *same* logic behaves identically against a real Stripe-backed payment record, not testing it for the first time.

### TEST F — Price manipulation
Using browser dev tools or a raw API client, attempt to call `/api/payments/intent` or `/api/bookings` with a manipulated price field. Confirm: the booking creation route never accepts a price from the client at all (`createBookingSchema` has no price field — check the schema directly), and `createPaymentIntentForBooking` computes the Stripe amount exclusively from `booking_price_components` in Postgres, never from anything in the request body. This should pass by construction, not by a special-case check — if it doesn't, that's a regression worth stopping everything for.

---

## 5. Remaining security items, stated plainly

- **Rate limiting**: implemented and live-verified, with the honest single-instance/Edge-runtime caveat documented in `middleware.ts` itself.
- **Email verification / password reset / MFA**: registration creates an active account immediately; no email verification gate exists yet.
- **`npm audit`**: 3 high-severity transitive advisories (`postcss`, `sharp` via `next@15.x`), fix requires a Next 16 upgrade — deliberately not bundled into this pass.
- **Webhook replay protection**: idempotent against reprocessing the *same* event's effects (checked via booking/payment status guards), but doesn't yet dedupe on Stripe's event `id` specifically via a dedicated table — flagged in the original technical spec, still open.

---

## 6. What's verified locally vs. what still needs real Stripe

**Verified locally, for real** (live Postgres, live Next.js, live authenticated sessions, genuinely HMAC-signed webhook payloads): registration, NextAuth sign-in, booking creation with real availability locking, the full webhook handler logic for both payment success and refund, cancellation, My Trips, archive, the PaymentIntent-reuse *decision logic* (the DB check, not the Stripe retrieve call), and all three refund-capping scenarios (over-request rejected, exact-remaining accepted through to Stripe, already-refunded rejected).

**Still requires a real Stripe Sandbox connection** — nothing below this line may be marked VERIFIED until Tests A–F above have actually been run against a live Stripe account: the literal `paymentIntents.create`/`retrieve`/`refunds.create` HTTP calls, Stripe.js loading in a real browser, a genuine Stripe-originated (not self-signed) webhook delivery, and 3D Secure/authentication-required flows (test card `4000 0025 0000 3155`) which have no local equivalent at all.
