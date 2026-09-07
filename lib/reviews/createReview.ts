import { withTransaction, db } from "../db";

export type CreateReviewInput = {
  bookingId: string;
  guestId: string;
  overall: number;
  cleanliness?: number;
  location?: number;
  accuracy?: number;
  communication?: number;
  comfort?: number;
  body?: string;
};

/**
 * Prevents fraudulent/unverified reviews by tying reviews to completed
 * bookings — enforced here, not just at the database level. A review can
 * only be created for a booking that (a) belongs to the requesting guest
 * and (b) has status='completed', which only the scheduled job in
 * scheduledNotifications.ts ever sets. There's no path to a review
 * existing for a booking nobody actually stayed at.
 */
export async function createReview(input: CreateReviewInput) {
  try {
    return await withTransaction(async (client) => {
      const booking = await client.query(
        `SELECT id, guest_id, property_id, status FROM bookings WHERE id = $1 FOR UPDATE`,
        [input.bookingId]
      );
      if (booking.rows.length === 0) throw new Error("Booking not found");
      const b = booking.rows[0];
      if (b.guest_id !== input.guestId) throw new Error("This booking doesn't belong to you");
      if (b.status !== "completed") throw new Error("Reviews can only be left after a completed stay");

      const existing = await client.query(`SELECT id FROM reviews WHERE booking_id = $1`, [input.bookingId]);
      if (existing.rows.length > 0) throw new Error("A review already exists for this booking");

      const review = await client.query(
        `INSERT INTO reviews (booking_id, property_id, guest_id, overall, cleanliness, location_rating, accuracy, communication, comfort, body)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
        [input.bookingId, b.property_id, input.guestId, input.overall, input.cleanliness ?? null, input.location ?? null, input.accuracy ?? null, input.communication ?? null, input.comfort ?? null, input.body ?? null]
      );

      await recalculatePropertyRating(client, b.property_id);
      return review.rows[0];
    });
  } catch (error) {
    // FOUND during Batch 8's audit: the app-level "existing review?"
    // check above isn't itself covered by a row lock on the reviews
    // table (only the booking row is locked), so two genuinely
    // simultaneous submissions for the same booking could both pass
    // that check before either INSERTs — the second would then hit the
    // real UNIQUE constraint on reviews.booking_id and throw a raw
    // Postgres error (code 23505) straight through to the caller. This
    // converts that specific case to the exact same clean, friendly
    // message the normal (non-race) duplicate check already produces,
    // rather than leaking an internal database error to the client.
    if ((error as { code?: string }).code === "23505") {
      throw new Error("A review already exists for this booking");
    }
    throw error;
  }
}

export async function replyToReview(reviewId: string, hostProfileId: string, reply: string) {
  const result = await withTransaction(async (client) => {
    const review = await client.query(
      `SELECT r.id, r.host_reply FROM reviews r JOIN properties p ON p.id = r.property_id WHERE r.id = $1 AND p.host_id = $2`,
      [reviewId, hostProfileId]
    );
    if (review.rows.length === 0) throw new Error("Review not found or doesn't belong to your property");
    // FOUND during Batch 8's audit: no prior guard existed against a
    // second reply silently overwriting the first — required explicitly
    // ("clear handling for already-replied").
    if (review.rows[0].host_reply !== null) throw new Error("You've already replied to this review");

    return client.query(
      `UPDATE reviews SET host_reply = $2, host_reply_at = NOW(), updated_at = NOW() WHERE id = $1 RETURNING *`,
      [reviewId, reply]
    );
  });
  return result.rows[0];
}

async function recalculatePropertyRating(client: { query: Function }, propertyId: string) {
  const agg = await client.query(
    `SELECT AVG(overall)::NUMERIC(3,2) AS avg_rating, COUNT(*)::INTEGER AS review_count
     FROM reviews WHERE property_id = $1 AND status = 'published'`,
    [propertyId]
  );
  await client.query(
    `UPDATE properties SET rating = $2, review_count = $3, updated_at = NOW() WHERE id = $1`,
    [propertyId, agg.rows[0].avg_rating, agg.rows[0].review_count]
  );
}

/** Powers the guest review page: check whether this specific booking
 *  already has a review (read-only view after submission), without
 *  needing a full property-wide listing. Deliberately does NOT filter by
 *  status here — the guest who WROTE the review should still see their
 *  own submission even if it were later flagged/removed by moderation,
 *  same principle as an owning host's preview access elsewhere in this
 *  project (the writer/owner sees their own content; the public does not). */
export async function getReviewForBooking(bookingId: string) {
  const result = await db.query(
    `SELECT id, booking_id, property_id, guest_id, overall, cleanliness, location_rating, accuracy, communication, comfort, body, host_reply, host_reply_at, status, created_at
     FROM reviews WHERE booking_id = $1`,
    [bookingId]
  );
  return result.rows[0] ?? null;
}

/**
 * Genuinely missing before this batch — confirmed by searching the
 * whole repository first. Powers the host reviews interface: every
 * review across every property this host actually owns, scoped via the
 * properties join (never a client-supplied property list), plus enough
 * property identification to filter/navigate between properties in the
 * UI. Includes ALL statuses (not just 'published') — a host should be
 * able to see a review that's been flagged/removed just as much as a
 * published one, since it's their own property being reviewed; only the
 * PUBLIC listing (listPropertyReviews) filters to published-only.
 */
export async function listReviewsForHost(hostProfileId: string) {
  const result = await db.query(
    `SELECT r.id, r.property_id, p.name AS property_name, r.overall, r.cleanliness, r.location_rating,
            r.accuracy, r.communication, r.comfort, r.body, r.host_reply, r.host_reply_at, r.status, r.created_at
     FROM reviews r
     JOIN properties p ON p.id = r.property_id
     WHERE p.host_id = $1
     ORDER BY r.created_at DESC`,
    [hostProfileId]
  );
  return result.rows;
}

export async function listPropertyReviews(propertyId: string) {
  const result = await db.query(
    `SELECT id, overall, cleanliness, location_rating, accuracy, communication, comfort, body, host_reply, host_reply_at, created_at
     FROM reviews WHERE property_id = $1 AND status = 'published' ORDER BY created_at DESC`,
    [propertyId]
  );
  return result.rows;
}
