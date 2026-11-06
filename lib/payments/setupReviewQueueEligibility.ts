// Booking-linked unresolved reviews, shared by the admin queue and digest.
export const setupReviewQueueEligibility = `FROM audit_log e
       JOIN bookings b ON b.id = e.object_id
       LEFT JOIN setup_review_cases c
         ON c.source_audit_id = e.id AND c.booking_id = e.object_id
       WHERE e.object_type = 'booking'
         AND e.action = 'setup_webhook_review_required'
         AND e.new_state->>'phase' IN ('payment_method_save', 'immediate_charge')
         AND e.new_state->'requiresReview' = 'true'::jsonb
         AND (c.source_audit_id IS NULL OR c.status IN ('open', 'in_review'))`;
