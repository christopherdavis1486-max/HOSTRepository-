-- Batch 9B-1: Stripe identifier persistence for separate_charges_delayed_v1
-- bookings. Purely additive, all nullable — legacy destination_charge_legacy
-- bookings never populate or read any of these columns. This migration is
-- built and tested in this sandbox only; per the explicit instruction, it is
-- NOT applied to production here. It is packaged for Batch 9B-2's controlled
-- integration and application by whoever runs it against the real database.

ALTER TABLE bookings ADD COLUMN IF NOT EXISTS stripe_customer_id TEXT;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS stripe_setup_intent_id TEXT;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS stripe_payment_method_id TEXT;
