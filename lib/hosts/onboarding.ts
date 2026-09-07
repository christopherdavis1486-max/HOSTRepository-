import { stripe } from "../payments/stripeClient";
import { db } from "../db";

/** Creates a host_profiles row for this user if one doesn't exist yet —
 *  called from the onboarding route now that hostProfileId comes from
 *  the session rather than the request body. Becoming a host is just
 *  "the first host_profiles row for this user_id gets created," not a
 *  separate registration step. Unchanged by the Accounts v2 migration. */
export async function ensureHostProfile(userId: string): Promise<string> {
  const existing = await db.query(`SELECT id FROM host_profiles WHERE user_id = $1`, [userId]);
  if (existing.rows.length > 0) return existing.rows[0].id;

  const created = await db.query(
    `INSERT INTO host_profiles (user_id, verification_status, payout_account_status) VALUES ($1, 'unverified', 'not_connected') RETURNING id`,
    [userId]
  );
  return created.rows[0].id;
}

/**
 * MIGRATED to Stripe Accounts v2 (/v2/core/accounts), then CORRECTED a
 * second time after a real production error on the merchant+recipient
 * combination: "This account configuration is not supported." Stripe's
 * Accounts v2 API is still in private preview, and that specific
 * combination — two configurations, on_behalf_of, platform-absorbs-fees
 * responsibilities — is one of the combinations not currently accepted.
 *
 * This is now Model A: recipient-only, no `on_behalf_of` on the
 * PaymentIntent (see createPaymentIntent.ts). Stripe's own docs describe
 * this exact pattern by name: "The recipient configuration includes the
 * stripe_balance.stripe_transfers capability... which is required to use
 * indirect charges" — "indirect charge" is Stripe's term for a
 * destination charge without on_behalf_of, which is precisely this.
 *
 * IMPORTANT — legal/commercial note, not a code concern: this technical
 * change means HOST's own Stripe account is the settlement party for
 * every charge (no on_behalf_of), which is a materially different
 * arrangement from having the connected account be the settlement
 * merchant. This code does not decide, assert, or imply who is legally
 * the "merchant of record" for HOST's business — that's a real
 * commercial/legal/tax question requiring its own review before launch,
 * deliberately out of scope here and left to that separate review.
 *
 * `dashboard: "express"` is unchanged from the prior pass — still correct
 * for a recipient-configured account: it gives hosts Stripe-hosted
 * balance/payout management without full Dashboard access.
 *
 * Currency/country: hardcoded to GB/gbp, matching HOST's current UK-first
 * scope throughout this project. This is a deliberate, stated choice, not
 * a silent guess — if HOST ever supports non-UK hosts, this needs a real
 * per-host country input, not an assumption baked in here.
 */
export async function startHostConnectOnboarding(hostProfileId: string, country: string, email: string, returnUrl: string, refreshUrl: string) {
  const existing = await db.query(`SELECT stripe_connect_account_id FROM host_profiles WHERE id = $1`, [hostProfileId]);
  if (existing.rows.length === 0) throw new Error("Host profile not found");

  let accountId = existing.rows[0].stripe_connect_account_id;
  if (!accountId) {
    const account = await stripe.v2.core.accounts.create({
      contact_email: email,
      dashboard: "express",
      identity: {
        country: country.toLowerCase(),
        entity_type: "individual", // HOST's current hosts are individual accommodation providers; company entities would need a real UI choice, not assumed here
      },
      configuration: {
        // recipient only — merchant removed. This account never accepts
        // its own direct charges; it only receives the transfer_data
        // transfer from HOST's PaymentIntent, which is exactly what
        // recipient + stripe_balance.stripe_transfers is documented for.
        recipient: {
          capabilities: {
            stripe_balance: {
              stripe_transfers: { requested: true },
            },
          },
        },
      },
      defaults: {
        currency: "gbp",
        // "application" (HOST) collects fees and bears losses — both
        // confirmed as real, valid enum values directly in the installed
        // SDK's types (Responsibilities.FeesCollector /
        // Responsibilities.LossesCollector both include 'application').
        // This is a provisional MVP choice, not a legal declaration —
        // see the doc comment above.
        responsibilities: { fees_collector: "application", losses_collector: "application" },
      },
    });
    accountId = account.id; // v2 account IDs use the same acct_... format as v1 — the existing stripe_connect_account_id column needs no schema change
    await db.query(
      `UPDATE host_profiles SET stripe_connect_account_id = $2, payout_account_status = 'pending', updated_at = NOW() WHERE id = $1`,
      [hostProfileId, accountId]
    );
  }

  // v2 Account Links (stripe.v2.core.accountLinks) — the v2-namespaced
  // hosted-onboarding API. `configurations` now lists only "recipient" —
  // the only configuration this account actually has.
  const accountLink = await stripe.v2.core.accountLinks.create({
    account: accountId,
    use_case: {
      type: "account_onboarding",
      account_onboarding: {
        configurations: ["recipient"],
        return_url: returnUrl,
        refresh_url: refreshUrl,
      },
    },
  });

  return { onboardingUrl: accountLink.url, accountId };
}

export type ReadinessStatus = "active" | "pending" | "not_connected";

/**
 * Replaces v1's flat account.charges_enabled / account.payouts_enabled /
 * account.details_submitted booleans — those fields don't exist in this
 * shape on a v2 Account.
 *
 * CORRECTED a second time, for Model A: no longer checks merchant or
 * card_payments at all — this account never has a merchant configuration.
 * Readiness is now exactly: recipient.applied, and
 * recipient.capabilities.stripe_balance.stripe_transfers.status ===
 * 'active'. That single capability is the one thing that actually has to
 * be true for HOST's transfer_data.destination transfer to succeed.
 */
export function computeReadinessStatus(account: {
  configuration?: {
    recipient?: {
      applied?: boolean;
      capabilities?: {
        stripe_balance?: { stripe_transfers?: { status?: string } };
      };
    };
  };
}): ReadinessStatus {
  const recipient = account.configuration?.recipient;
  if (!recipient?.applied) return "not_connected";
  const transfersActive = recipient.capabilities?.stripe_balance?.stripe_transfers?.status === "active";
  return transfersActive ? "active" : "pending";
}

export async function getHostOnboardingStatus(hostProfileId: string) {
  const result = await db.query(`SELECT stripe_connect_account_id, payout_account_status FROM host_profiles WHERE id = $1`, [hostProfileId]);
  if (result.rows.length === 0) throw new Error("Host profile not found");
  const row = result.rows[0];
  if (!row.stripe_connect_account_id) return { status: "not_connected" as ReadinessStatus };

  // Re-check against Stripe directly rather than trusting only the last
  // webhook — covers the case where the host completed onboarding in a
  // tab we never got a webhook for yet (webhooks can lag by a few seconds).
  //
  // `include` now requests only "configuration.recipient" — the only
  // configuration this account has, and the only one
  // computeReadinessStatus() reads.
  const account = await stripe.v2.core.accounts.retrieve(row.stripe_connect_account_id, {
    include: ["configuration.recipient"],
  });
  const status = computeReadinessStatus(account);
  if (status !== row.payout_account_status) {
    await db.query(`UPDATE host_profiles SET payout_account_status = $2, updated_at = NOW() WHERE id = $1`, [hostProfileId, status]);
  }
  return { status };
}
