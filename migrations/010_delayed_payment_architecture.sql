-- Batch 9 (Payment Integrity and Delayed Host Transfers) — inert schema only.
-- No financial behaviour is activated by this migration. All new code paths
-- that read these columns/tables remain gated behind feature flags that
-- default OFF (see lib/config/featureFlags.ts). Existing `payments` and
-- `payouts` tables are completely untouched — every legacy destination-charge
-- booking continues exactly as before.

-- ============================================================
-- 1. Immutable payment_flow_version + fail-closed tax_treatment
-- ============================================================

-- Every EXISTING booking was created under the current (destination-charge)
-- architecture — this default is correct and permanent for all of them.
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS payment_flow_version TEXT NOT NULL DEFAULT 'destination_charge_legacy';

DO $$ BEGIN
  ALTER TABLE bookings ADD CONSTRAINT payment_flow_version_valid
    CHECK (payment_flow_version IN ('destination_charge_legacy', 'separate_charges_delayed_v1'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Fail-closed: 'unconfigured' is the safe default until a real business/legal
-- decision is made (see lib/config/taxTreatment.ts). Legacy bookings never
-- read this field at all — their payment path is completely unchanged — so
-- defaulting it here is harmless for them.
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS tax_treatment TEXT NOT NULL DEFAULT 'unconfigured';

DO $$ BEGIN
  ALTER TABLE bookings ADD CONSTRAINT tax_treatment_valid
    CHECK (tax_treatment IN ('host_remits', 'platform_remits', 'unconfigured'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Real, database-level immutability for payment_flow_version — not a code
-- convention. Any UPDATE attempting to change this value on an existing row
-- is rejected outright by Postgres itself, regardless of what application
-- code does or doesn't do.
CREATE OR REPLACE FUNCTION enforce_payment_flow_version_immutable()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD.payment_flow_version IS DISTINCT FROM NEW.payment_flow_version THEN
    RAISE EXCEPTION 'payment_flow_version is immutable once set (booking %, was %, attempted %)',
      OLD.id, OLD.payment_flow_version, NEW.payment_flow_version;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_payment_flow_version_immutable ON bookings;
CREATE TRIGGER trg_payment_flow_version_immutable
  BEFORE UPDATE ON bookings
  FOR EACH ROW
  EXECUTE FUNCTION enforce_payment_flow_version_immutable();

-- Maximum advance-booking horizon and past-check-in rejection are enforced
-- in application code (lib/validation/schemas.ts, lib/booking/createBooking.ts)
-- since they depend on "now", which a static CHECK constraint cannot express
-- portably across Postgres versions without STABLE/IMMUTABLE function
-- complications; enforcing them at the point of booking creation, in the
-- same transaction as every other booking-creation validation, is the
-- correct layer — consistent with how every other booking-creation rule in
-- this codebase already works.

-- ============================================================
-- 2. payment_attempts — genuinely new: the existing `payments` table has a
--    UNIQUE constraint on booking_id (confirmed by direct audit), meaning it
--    cannot represent multiple charge attempts for one booking. This table
--    is what the delayed-charge retry/grace-period design requires; it is
--    used ONLY for separate_charges_delayed_v1 bookings. Legacy bookings
--    continue using the existing `payments` table exactly as before.
-- ============================================================

CREATE TABLE IF NOT EXISTS payment_attempts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    booking_id UUID NOT NULL REFERENCES bookings(id),
    attempt_number INTEGER NOT NULL,
    provider_payment_intent_id TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    -- pending|processing|succeeded|failed|requires_action|cancelled
    failure_code TEXT,
    failure_message TEXT,
    amount_minor INTEGER NOT NULL,
    currency CHAR(3) NOT NULL,
    idempotency_key TEXT NOT NULL UNIQUE,
    attempted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (booking_id, attempt_number)
);

CREATE INDEX IF NOT EXISTS idx_payment_attempts_booking ON payment_attempts(booking_id);
CREATE INDEX IF NOT EXISTS idx_payment_attempts_status ON payment_attempts(status);

-- ============================================================
-- 3. host_transfer_entitlements / host_transfer_reversals — genuinely new.
--    The EXISTING `payouts` table (and its own provider_transfer_id column)
--    is preserved untouched as the permanent legacy record — legacy
--    reconciliation writes discovered transfer IDs into THAT existing
--    column, it does not create rows here. These new tables are used ONLY
--    for separate_charges_delayed_v1 bookings, and only ever created after
--    a real payment_attempts row shows status='succeeded' — never at charge
--    time, and never automatically as a side effect of any charge.
-- ============================================================

CREATE TABLE IF NOT EXISTS host_transfer_entitlements (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    booking_id UUID NOT NULL UNIQUE REFERENCES bookings(id),
    host_id UUID NOT NULL REFERENCES host_profiles(id),
    amount_minor INTEGER NOT NULL,
    tax_amount_minor INTEGER,
    currency CHAR(3) NOT NULL,
    status TEXT NOT NULL DEFAULT 'entitled',
    -- entitled|release_due|transfer_claimed|transfer_created|transfer_failed|cancelled_before_transfer
    scheduled_release_at TIMESTAMPTZ NOT NULL,
    claimed_at TIMESTAMPTZ,
    claimed_by_worker_id TEXT,
    provider_transfer_id TEXT UNIQUE,
    idempotency_key TEXT NOT NULL UNIQUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_host_transfer_entitlements_status ON host_transfer_entitlements(status);
CREATE INDEX IF NOT EXISTS idx_host_transfer_entitlements_release ON host_transfer_entitlements(scheduled_release_at);

CREATE TABLE IF NOT EXISTS host_transfer_reversals (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    entitlement_id UUID NOT NULL REFERENCES host_transfer_entitlements(id),
    amount_minor INTEGER NOT NULL,
    reason TEXT NOT NULL, -- refund|dispute
    status TEXT NOT NULL DEFAULT 'reversal_requested',
    -- reversal_requested|reversal_confirmed|reversal_failed
    provider_reversal_id TEXT,
    idempotency_key TEXT NOT NULL UNIQUE,
    requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    confirmed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_host_transfer_reversals_entitlement ON host_transfer_reversals(entitlement_id);
