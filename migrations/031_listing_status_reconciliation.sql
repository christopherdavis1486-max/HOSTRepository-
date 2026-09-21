-- Reconcile legacy listings that retained a published
-- database status without an approved final pilot review.
-- Guest-facing queries already fail closed for these rows; this
-- migration aligns the host-visible status with actual availability.

UPDATE properties
SET status = 'draft',
    updated_at = NOW()
WHERE status = 'published'
  AND pilot_review_status IS DISTINCT FROM 'approved';
