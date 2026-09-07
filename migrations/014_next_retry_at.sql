-- Structural, database-backed retry-eligibility gate — fixes a real
-- design gap found via the concurrency-safety tests: two genuinely
-- concurrent callers where the first attempt fails quickly could both
-- reserve separate real charge attempts, since a terminal 'failed'
-- status wasn't treated as "still relevant" for deduplication purposes.
-- next_retry_at is the explicit fix: set once a charge attempt fails,
-- checked (inside the same advisory-lock-protected decision phase
-- attemptScheduledCharge() already uses) before any subsequent attempt
-- may be reserved. Deliberately mutable, unlike grace_period_started_at
-- — it legitimately advances on each subsequent failure — but always
-- bounded in effect by the immutable 72-hour grace deadline, which a
-- retry can never be scheduled past in any way that matters (the grace
-- expiry check refuses first).

ALTER TABLE bookings ADD COLUMN IF NOT EXISTS next_retry_at TIMESTAMPTZ;
