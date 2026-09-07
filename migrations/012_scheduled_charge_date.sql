-- Persists the once-decided scheduled charge date for
-- separate_charges_delayed_v1 bookings, rather than repeatedly
-- recalculating it from check_in and "now" every time it's needed —
-- confirmed as a real correctness gap: without a stored value, the cron
-- sweep's own "is this booking due" query had no way to check timing at
-- all, risking a premature charge on a booking correctly deferred by
-- onSetupIntentSucceeded(). NULL for every legacy booking and for any
-- new-architecture booking decided to be immediate (charged right away
-- via the webhook flow, never through the scheduled cron path).
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS scheduled_charge_date TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_bookings_scheduled_charge_date ON bookings(scheduled_charge_date) WHERE scheduled_charge_date IS NOT NULL;
