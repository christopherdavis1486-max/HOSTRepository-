import Stripe from "stripe";
import { stripe } from "./stripeClient";
import { db, withTransaction } from "../db";
import { sendBookingConfirmedMessage } from "../messaging/systemMessages";
import { notifyUser } from "../notifications/sendNotification";
import { computeReadinessStatus } from "../hosts/onboarding";
import { computeRefundReversalEntries } from "./refundReversal";

/**
 * The single most important file in this package, structurally: every
 * other route can create pending state, but only this handler — triggered
 * by Stripe itself, signature-verified — is allowed to confirm a payment,
 * confirm a refund, or schedule a payout. Non-negotiable #2 from the
 * technical spec ("the payment provider confirms — not the frontend")
 * lives here, not in app/api/payments/intent/route.ts.
 *
 * Idempotency: every handler below checks the current DB state before
 * writing, so a duplicate webhook delivery (Stripe explicitly does not
 * guarantee exactly-once delivery) never double-applies a ledger entry
 * or double-schedules a payout.
 */

/**
 * Verifies a classic v1 webhook signature against STRIPE_WEBHOOK_SECRET.
 *
 * A second secret (STRIPE_REFUND_WEBHOOK_SECRET) was previously supported
 * here as a fallback, on the assumption that refund.created/updated/failed
 * might arrive via a second Stripe Event Destination with its own signing
 * secret. Confirmed against the real, already-configured Stripe Sandbox
 * Event Destination that this is not the case: the existing destination
 * pointed at this same /api/webhooks/stripe URL is already subscribed to
 * payment_intent.succeeded, payment_intent.payment_failed, refund.created,
 * refund.updated, and refund.failed — all five events arrive signed with
 * the single, existing STRIPE_WEBHOOK_SECRET. No second Event Destination
 * or second secret is required.
 */
function verifyStripeEvent(rawBody: string, signature: string): Stripe.Event {
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!webhookSecret) {
    // Distinguished from a genuine signature mismatch — this is a
    // configuration error, not a suspicious request. Common cause when
    // testing locally: `stripe listen` prints its own ephemeral signing
    // secret ("Your webhook signing secret is whsec_...") that is
    // DIFFERENT from any Dashboard-configured Event Destination secret —
    // STRIPE_WEBHOOK_SECRET in the running server's .env.local must be
    // set to that CLI-provided value for local Stripe CLI testing.
    throw new Error("STRIPE_WEBHOOK_SECRET is not configured — webhook signature verification cannot proceed.");
  }
  return stripe.webhooks.constructEvent(rawBody, signature, webhookSecret);
}

export async function handleStripeWebhook(rawBody: string, signature: string) {
  const event = verifyStripeEvent(rawBody, signature);

  switch (event.type) {
    case "payment_intent.succeeded":
      await onPaymentSucceeded(event.data.object as Stripe.PaymentIntent);
      break;
    case "payment_intent.payment_failed":
      await onPaymentFailed(event.data.object as Stripe.PaymentIntent);
      break;
    // Diagnosed and fixed: setup_intent.succeeded was previously
    // unhandled (falling through to the default no-op below), which is
    // exactly why a completed SetupIntent never led anywhere — no
    // PaymentIntent was ever created, so the booking sat in
    // pending_payment forever. A SetupIntent collects no money, so this
    // must never confirm the booking itself — it only triggers the real
    // PaymentIntent creation. See lib/payments/newFlowWebhookHandling.ts's
    // onSetupIntentSucceeded() for the full reasoning.
    case "setup_intent.succeeded": {
      const { onSetupIntentSucceeded } = await import("./newFlowWebhookHandling");
      await onSetupIntentSucceeded(event.data.object as Stripe.SetupIntent);
      break;
    }
    case "refund.created":
    case "refund.updated":
      await onRefundEvent(event.data.object as Stripe.Refund);
      break;
    case "refund.failed":
      await onRefundFailed(event.data.object as Stripe.Refund);
      break;
    case "charge.dispute.created":
      await onDisputeCreated(event.data.object as Stripe.Dispute);
      break;
    case "account.updated":
      await onConnectedAccountUpdated(event.data.object as Stripe.Account);
      break;
    default:
      // Unhandled event types are fine to ignore — Stripe sends far more
      // event types than any one integration needs to act on.
      break;
  }

  return { received: true };
}

async function onPaymentSucceeded(intent: Stripe.PaymentIntent) {
  const bookingId = intent.metadata?.booking_id;
  if (!bookingId) return;

  // Batch 9B-1: the ONLY change to this function. Confirmed by direct
  // reading before writing this: without this explicit, early check, a
  // new-architecture (separate_charges_delayed_v1) PaymentIntent's
  // webhook would fall through into all the legacy-only logic below
  // (ledger writes, the OLD payouts table's scheduling rule) — those
  // attempts are never recorded in the legacy `payments` table, so the
  // `payment.rows.length > 0 && status === 'paid'` guard below would
  // never trigger its early-return, and the generic
  // `WHERE id = $1 AND status = 'pending_payment'` booking-confirmation
  // query would still match and silently confirm the booking while
  // running entirely the wrong financial bookkeeping for it. Routed to
  // its own, completely separate function instead — see
  // lib/payments/newFlowWebhookHandling.ts. Legacy behaviour below this
  // check is byte-for-byte unchanged.
  if (intent.metadata?.payment_flow_version === "separate_charges_delayed_v1") {
    const { onNewFlowPaymentSucceeded } = await import("./newFlowWebhookHandling");
    await onNewFlowPaymentSucceeded(intent);
    return;
  }

const shouldNotify = await withTransaction(async (client) => {   
const payment = await client.query(`SELECT status FROM payments WHERE provider_payment_intent_id = $1 FOR UPDATE`, [intent.id]);
    if (payment.rows.length > 0 && payment.rows[0].status === "paid") return false; // already processed — idempotent no-op

    await client.query(`UPDATE payments SET status = 'paid', updated_at = NOW() WHERE provider_payment_intent_id = $1`, [intent.id]);

    const bookingResult = await client.query(
      `UPDATE bookings SET status = 'confirmed', updated_at = NOW()
       WHERE id = $1 AND status = 'pending_payment' RETURNING *`,
      [bookingId]
    );
if (bookingResult.rows.length === 0) return false; // already confirmed, or in an unexpected state — don't overwrite
    const booking = bookingResult.rows[0];

    const priceComponents = await client.query(`SELECT * FROM booking_price_components WHERE booking_id = $1`, [bookingId]);
    const pc = priceComponents.rows[0];
    const now = new Date();

    const ledgerRows: [string, number, string][] = [
      ["guest_charge", pc.guest_total_minor, "paid"],
      ["accommodation_revenue", pc.accommodation_minor, "paid"],
      ["cleaning_fee", pc.cleaning_minor, "paid"],
      ["guest_service_fee", pc.guest_service_fee_minor, "paid"],
      ["taxes", pc.taxes_minor, "paid"],
      ["host_commission", pc.host_commission_minor, "paid"],
      ["host_revenue", pc.host_revenue_minor, "paid"],
    ];
    for (const [type, amount, status] of ledgerRows) {
      await client.query(
        `INSERT INTO ledger_entries (booking_id, property_id, host_id, type, amount_minor, currency, status, external_reference, occurred_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [bookingId, booking.property_id, booking.host_id, type, amount, pc.currency, status, intent.id, now]
      );
    }

    // Payout scheduling — held until check-in + the free-cancellation
    // window closes (§30). See lib/payouts/schedulePayout.ts for the exact
    // rule; duplicated here as a direct call to keep it in the same
    // transaction as the ledger writes above.
    const policy = booking.cancellation_policy_snapshot as { cutoffHours: number; refundPercent: number }[];
    const freeCancelCutoffHours = Math.max(...policy.filter(r => r.refundPercent === 100).map(r => r.cutoffHours), 0);
    await client.query(
      `INSERT INTO payouts (host_id, booking_id, amount_minor, currency, status, scheduled_release_at)
       VALUES ($1,$2,$3,$4,'scheduled', GREATEST($5::timestamptz, NOW() + ($6 || ' hours')::interval))`,
      [booking.host_id, bookingId, pc.host_payout_minor, pc.currency, booking.check_in, freeCancelCutoffHours]
    );
       await client.query(
      `INSERT INTO ledger_entries (booking_id, property_id, host_id, type, amount_minor, currency, status, external_reference, occurred_at)
       VALUES ($1,$2,$3,'host_payout',$4,$5,'pending',$6,NOW())`,
      [bookingId, booking.property_id, booking.host_id, pc.host_payout_minor, pc.currency, intent.id]
    );

    return true;
  });
  
  // Outside the transaction — messaging/email are external side effects
  // and shouldn't hold a database transaction open while they run. A
  // failure here (e.g. the email provider is briefly down) must not roll
  // back a payment that genuinely succeeded — notifyUser already catches
  // and records email failures internally rather than throwing.
  if (shouldNotify) {
    await sendBookingConfirmedMessage(bookingId);
  }
}

async function onPaymentFailed(intent: Stripe.PaymentIntent) {
  await db.query(
    `UPDATE payments SET status = 'failed', failure_code = $2, failure_message = $3, updated_at = NOW()
     WHERE provider_payment_intent_id = $1`,
    [intent.id, intent.last_payment_error?.code ?? null, intent.last_payment_error?.message ?? null]
  );
  // Booking deliberately stays 'pending_payment' here, not 'cancelled' —
  // the guest may retry with a different payment method before the hold
  // expires. The expiry sweep (createBooking.ts's releaseExpiredHold) is
  // what actually cancels it if no successful payment follows.
  const bookingId = intent.metadata?.booking_id;
  if (bookingId) {
    const booking = await db.query(`SELECT guest_id FROM bookings WHERE id = $1`, [bookingId]);
    if (booking.rows.length > 0) {
      await notifyUser(booking.rows[0].guest_id, "payment_failed", { bookingRef: bookingId });
    }
  }
}

/**
 * CORRECTED twice now, during two successive financial-integrity
 * follow-up reviews of the original ledger reconciliation fix:
 *
 * (1) Event coverage — originally listened only for `refund.updated`.
 * Stripe's refund lifecycle also includes `refund.created` (which can
 * already report status "succeeded" for instantly-processed refunds —
 * waiting for a separate `refund.updated` in that case would mean HOST
 * never recognizes the reversal at all) and `refund.failed`. Both
 * `refund.created` and `refund.updated` now route here; `refund.failed`
 * is handled separately below, and never touches the ledger or payout at
 * all, since this function only ever acts when status === "succeeded".
 *
 * (2) Rounding — see refundReversal.ts's doc comment for the full
 * explanation of the cumulative-target allocation fix. This function's
 * job is to gather the two real inputs that calculation needs: the
 * CURRENT cumulative refunded amount (from HOST's own refunds table) and
 * how much of EACH category has already been reversed so far (from
 * HOST's own ledger_entries) — both queried fresh inside this same
 * transaction, so the calculation always reflects true current state
 * regardless of event arrival order.
 *
 * REQUIRES a Stripe Dashboard change: the classic webhook endpoint must
 * be subscribed to `refund.created`, `refund.updated`, and
 * `refund.failed` (none of these were part of whatever event list was
 * configured for `charge.refunded` previously).
 */
async function onRefundEvent(refund: Stripe.Refund) {
  if (refund.status !== "succeeded") return; // refund.created arriving as "pending" must not recognise the reversal prematurely — only act on genuine completion

  const paymentIntentId = typeof refund.payment_intent === "string" ? refund.payment_intent : refund.payment_intent?.id;
  if (!paymentIntentId) return;

  // FOUND during Batch 7's notification audit: "refund_issued" already
  // existed as a notification type/template but was never actually
  // fired anywhere. Captured here, in the outer function scope, so the
  // notification can fire AFTER the transaction below commits — never
  // from inside it, matching the exact same safe pattern
  // sendBookingConfirmedMessage() already uses elsewhere in this file.
  // No ledger/accounting/payout logic in the transaction below is
  // touched by this addition.
  let notifyInfo: { guestId: string; bookingId: string; amountMinor: number; currency: string } | null = null;

  await withTransaction(async (client) => {
    const payment = await client.query(
      `SELECT id, booking_id, amount_minor FROM payments WHERE provider_payment_intent_id = $1 FOR UPDATE`,
      [paymentIntentId]
    );
    if (payment.rows.length === 0) return;
    const { id: paymentId, booking_id: bookingId, amount_minor: originalChargeAmount } = payment.rows[0];

    // Idempotency, precise: matched by the EXACT Stripe refund id, not
    // "most recent pending" (found earlier this session to be capable of
    // matching the wrong row under concurrent pending refunds). The
    // `AND status != 'succeeded'` guard is what makes redelivery of the
    // same event — or receiving BOTH refund.created and refund.updated
    // for the one refund — a safe no-op: RETURNING gives zero rows after
    // the first time.
    const matchedRefund = await client.query(
      `UPDATE refunds SET status = 'succeeded', updated_at = NOW()
       WHERE provider_refund_id = $1 AND status != 'succeeded'
       RETURNING id`,
      [refund.id]
    );
    if (matchedRefund.rows.length === 0) return; // already processed, or not a refund HOST itself initiated

    // Cumulative "is this booking now fully refunded" is computed from
    // HOST's OWN refunds table, not Stripe's charge.amount_refunded —
    // avoids needing to fetch the Charge object at all, and is exactly
    // as authoritative (every succeeded refund on this booking was
    // itself confirmed via this same webhook path).
    const cumulativeResult = await client.query(
      `SELECT COALESCE(SUM(amount_minor), 0) AS total FROM refunds WHERE booking_id = $1 AND status = 'succeeded'`,
      [bookingId]
    );
    const cumulativeRefunded = Number(cumulativeResult.rows[0].total);
    const fullyRefunded = cumulativeRefunded >= originalChargeAmount;

    await client.query(
      `UPDATE payments SET status = $2, updated_at = NOW() WHERE id = $1`,
      [paymentId, fullyRefunded ? "refunded" : "partially_refunded"]
    );
    await client.query(
      `UPDATE bookings SET status = $2, updated_at = NOW() WHERE id = $1`,
      [bookingId, fullyRefunded ? "refunded" : "confirmed"]
    );

    const priceResult = await client.query(
      `SELECT accommodation_minor, cleaning_minor, guest_service_fee_minor, taxes_minor,
              host_commission_minor, host_revenue_minor, host_payout_minor, currency
       FROM booking_price_components WHERE booking_id = $1`,
      [bookingId]
    );
    if (priceResult.rows.length === 0) return; // shouldn't happen for a booking that reached payment — defensive, not expected
    const pc = priceResult.rows[0];

    // How much of each category has already been reversed by PRIOR
    // refund events on this booking — the second input the
    // cumulative-target calculation needs. Queried fresh here, inside
    // this same transaction, so it reflects true current state even if
    // events for different refunds arrive out of order.
    const alreadyReversedResult = await client.query(
      `SELECT type, COALESCE(SUM(amount_minor), 0) AS total
       FROM ledger_entries WHERE booking_id = $1 AND status = 'reversed' GROUP BY type`,
      [bookingId]
    );
    const alreadyReversedByType: Record<string, number> = {};
    for (const row of alreadyReversedResult.rows) alreadyReversedByType[row.type] = -Number(row.total); // stored as negative; flip to positive magnitude

    const { rows: reversalRows, hostPayoutReversalMinor } = computeRefundReversalEntries(
      {
        accommodationMinor: pc.accommodation_minor,
        cleaningMinor: pc.cleaning_minor,
        guestServiceFeeMinor: pc.guest_service_fee_minor,
        taxesMinor: pc.taxes_minor,
        hostCommissionMinor: pc.host_commission_minor,
        hostRevenueMinor: pc.host_revenue_minor,
        hostPayoutMinor: pc.host_payout_minor,
      },
      {
        accommodationMinor: alreadyReversedByType.accommodation_revenue ?? 0,
        cleaningMinor: alreadyReversedByType.cleaning_fee ?? 0,
        guestServiceFeeMinor: alreadyReversedByType.guest_service_fee ?? 0,
        taxesMinor: alreadyReversedByType.taxes ?? 0,
        hostCommissionMinor: alreadyReversedByType.host_commission ?? 0,
        hostRevenueMinor: alreadyReversedByType.host_revenue ?? 0,
        hostPayoutMinor: alreadyReversedByType.host_payout ?? 0,
      },
      refund.amount, // Stripe's own exact figure for this specific refund — no rounding involved in this one
      cumulativeRefunded,
      originalChargeAmount
    );

    const bookingRow = await client.query(`SELECT property_id, host_id, guest_id FROM bookings WHERE id = $1`, [bookingId]);
    const { property_id: propertyId, host_id: hostId, guest_id: guestId } = bookingRow.rows[0];
    const now = new Date();
    notifyInfo = { guestId, bookingId, amountMinor: refund.amount, currency: pc.currency };

    for (const row of reversalRows) {
      await client.query(
        `INSERT INTO ledger_entries (booking_id, property_id, host_id, type, amount_minor, currency, status, external_reference, occurred_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [bookingId, propertyId, hostId, row.type, row.amountMinor, pc.currency, row.status, refund.id, now]
      );
    }

    // The payout table is a planned-action record, not an append-only
    // ledger — reducing or cancelling a not-yet-released 'scheduled' row
    // is a legitimate mutation, unlike ledger_entries. Subtracting THIS
    // event's incremental reversal (the cumulative-target calculation's
    // output, not a raw per-event fraction) is what makes sequential
    // partial refunds accumulate to exactly the right total with zero
    // residual at 100%. Guarded to only ever touch a row still
    // 'scheduled': if a payout somehow already shows 'paid' by the time
    // a refund arrives (a real, if unlikely, race), this deliberately
    // does NOT try to silently claw it back via a database update —
    // that's a genuine operational/collections situation needing human
    // attention. The ledger reversal above still gets recorded either way.
    if (fullyRefunded) {
      await client.query(
        `UPDATE payouts SET status = 'cancelled', updated_at = NOW() WHERE booking_id = $1 AND status = 'scheduled'`,
        [bookingId]
      );
    } else if (hostPayoutReversalMinor > 0) {
      await client.query(
        `UPDATE payouts SET amount_minor = amount_minor - $2, updated_at = NOW() WHERE booking_id = $1 AND status = 'scheduled'`,
        [bookingId, hostPayoutReversalMinor]
      );
    }
  });

  if (notifyInfo) {
    const info: { guestId: string; bookingId: string; amountMinor: number; currency: string } = notifyInfo;
    try {
      await notifyUser(info.guestId, "refund_issued", {
        bookingRef: info.bookingId,
        refundAmount: `${(info.amountMinor / 100).toFixed(2)} ${info.currency}`,
      });
    } catch (err) {
      // notifyUser already catches its own internal failures (email
      // send, etc.) — this outer catch is defense-in-depth so a
      // notification problem can never surface as if the refund itself
      // failed, since by this point the refund has already genuinely
      // succeeded and been fully recorded.
      console.error("[HOST onRefundEvent] refund_issued notification failed", info.bookingId, err);
    }
  }
}

/**
 * `refund.failed` — new this pass. Since onRefundEvent() only ever
 * applies a reversal when a refund's status is "succeeded", a refund
 * that fails can never have had a reversal applied for it in the first
 * place (Stripe's refund lifecycle doesn't go succeeded -> failed; a
 * failure means it never reached succeeded at all). So there is nothing
 * to undo here — this only needs to mark the local row so the rest of
 * the system (support tooling, the admin refund-capping logic's
 * remaining-balance calculation) stops treating it as a live attempt.
 *
 * `AND status != 'succeeded'` is a defensive guard, not an expected
 * path: it should be structurally impossible for a refund already
 * marked succeeded to later report failed, but this ensures a
 * late/misordered failed event can never downgrade a genuinely
 * completed refund.
 */
async function onRefundFailed(refund: Stripe.Refund) {
  await db.query(
    `UPDATE refunds SET status = 'failed', updated_at = NOW() WHERE provider_refund_id = $1 AND status != 'succeeded'`,
    [refund.id]
  );
}

async function onDisputeCreated(dispute: Stripe.Dispute) {
  const paymentIntentId = typeof dispute.payment_intent === "string" ? dispute.payment_intent : dispute.payment_intent?.id;
  if (!paymentIntentId) return;

  const payment = await db.query(`SELECT id, booking_id FROM payments WHERE provider_payment_intent_id = $1`, [paymentIntentId]);
  if (payment.rows.length === 0) return;
  const { id: paymentId, booking_id: bookingId } = payment.rows[0];

  await db.query(
    `INSERT INTO disputes (booking_id, payment_id, provider_dispute_id, reason, status, amount_minor, evidence_due_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT DO NOTHING`,
    [bookingId, paymentId, dispute.id, dispute.reason, dispute.status, dispute.amount, dispute.evidence_details?.due_by ? new Date(dispute.evidence_details.due_by * 1000) : null]
  );
  await db.query(`UPDATE bookings SET status = 'disputed', updated_at = NOW() WHERE id = $1`, [bookingId]);
  // Also cancel any scheduled-but-unreleased payout for this booking —
  // don't pay out a host while the charge is under dispute.
  await db.query(`UPDATE payouts SET status = 'cancelled', updated_at = NOW() WHERE booking_id = $1 AND status = 'scheduled'`, [bookingId]);
}

/**
 * v1 `account.updated` handler — intentionally UNCHANGED and still wired
 * into the switch statement above. This is not an oversight: any
 * host_profiles row whose stripe_connect_account_id was created before
 * the Accounts v2 migration (via the old stripe.accounts.create({ type:
 * "express" }) call) is a genuine v1 Account, and Stripe will keep
 * sending it classic v1 `account.updated` events with these exact fields
 * forever — v1 accounts don't retroactively become v2 accounts. Removing
 * this would silently stop tracking readiness for any host onboarded
 * before this migration. New hosts, onboarded via the v2 flow in
 * lib/hosts/onboarding.ts, will never trigger this handler at all — they
 * report readiness through the v2 thin-event path below instead.
 */
async function onConnectedAccountUpdated(account: Stripe.Account) {
  const status = account.charges_enabled && account.payouts_enabled ? "active" : account.details_submitted ? "pending" : "not_connected";
  await db.query(
    `UPDATE host_profiles SET payout_account_status = $2, updated_at = NOW() WHERE stripe_connect_account_id = $1`,
    [account.id, status]
  );
}

/**
 * Accounts v2 readiness updates. Stripe v2 uses a structurally different
 * event delivery mechanism ("thin events" via a registered Event
 * Destination) than the classic v1 webhook this file already handles —
 * confirmed directly from the installed SDK: v2 events are verified with
 * `stripe.parseEventNotification(payload, header, secret)`, a distinct
 * method from `stripe.webhooks.constructEvent()`, and critically requires
 * ITS OWN signing secret from a separate Stripe Dashboard "Event
 * Destination" registration — NOT the existing STRIPE_WEBHOOK_SECRET used
 * for v1 events.
 *
 * CORRECTED for Model A (recipient-only connected accounts — see
 * onboarding.ts's doc comment for why merchant was removed): the
 * merchant capability event no longer applies, since these accounts
 * never have a merchant configuration at all.
 *
 * Event types HOST subscribes to:
 *   - v2.core.account[configuration.recipient].capability_status_updated
 *   - v2.core.account[requirements].updated
 *
 * Received live via app/api/webhooks/stripe-v2/route.ts, which calls this
 * function directly — wired up in an earlier pass, not merely written
 * and unused.
 */
export async function handleStripeV2ThinEvent(rawBody: string, signatureHeader: string, eventDestinationSecret: string) {
  const notification = stripe.parseEventNotification(rawBody, signatureHeader, eventDestinationSecret);

  if (
    notification.type === "v2.core.account[configuration.recipient].capability_status_updated" ||
    notification.type === "v2.core.account[requirements].updated"
  ) {
    const relatedObject = notification.related_object;
    if (!relatedObject?.id) return { received: true };

    const account = await stripe.v2.core.accounts.retrieve(relatedObject.id, {
      include: ["configuration.recipient"],
    });
    const status = computeReadinessStatus(account);
    await db.query(
      `UPDATE host_profiles SET payout_account_status = $2, updated_at = NOW() WHERE stripe_connect_account_id = $1`,
      [relatedObject.id, status]
    );
  }

  return { received: true };
}
