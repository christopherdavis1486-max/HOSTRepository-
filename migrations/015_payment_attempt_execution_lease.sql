-- Fixes a real defect found by direct code review: after a worker
-- reserves and commits a new 'pending' payment_attempts row and
-- releases the advisory lock, a second, genuinely concurrent worker's
-- own decision phase could see status='pending', conclude "reuse this
-- attempt", and proceed to call stripe.paymentIntents.create() with the
-- SAME idempotency key as the first worker — a real production risk,
-- since Stripe does not guarantee safety for two simultaneous requests
-- sharing one idempotency key (it may return idempotency_key_in_use to
-- one caller).
--
-- claim_token + lease_expires_at implement an exclusive execution lease:
-- exactly one worker may hold an active claim on a given attempt at a
-- time, and only the holder of a matching claim_token may record that
-- attempt's outcome (a compare-and-set write, preventing a late,
-- stale worker from ever overwriting a result — most importantly,
-- never downgrading a genuinely succeeded attempt).
ALTER TABLE payment_attempts ADD COLUMN IF NOT EXISTS claim_token UUID;
ALTER TABLE payment_attempts ADD COLUMN IF NOT EXISTS lease_expires_at TIMESTAMPTZ;
