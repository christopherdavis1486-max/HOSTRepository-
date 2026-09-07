import { db } from "../db";

/**
 * Reuses the EXISTING availability_blocks table exactly as
 * lib/booking/createBooking.ts already uses it — same table, same
 * status/source columns, no second availability system. Confirmed by
 * reading createBooking.ts directly before writing this: a real booking
 * writes status='booked', source='booking' for every date in its range.
 * Host-initiated blocks use status='blocked', source='host' — a
 * genuinely distinct pair of values, which is what makes it possible to
 * tell the two apart later, and — critically — what makes it safe to
 * NEVER let a host's "unblock" action touch a source='booking' row: a
 * host clearing their own manual block must not be able to accidentally
 * clear a real guest booking's availability lock.
 */

function enumerateDates(checkIn: string, checkOut: string): string[] {
  const dates: string[] = [];
  const current = new Date(checkIn + "T00:00:00Z");
  const end = new Date(checkOut + "T00:00:00Z");
  while (current < end) {
    dates.push(current.toISOString().slice(0, 10));
    current.setUTCDate(current.getUTCDate() + 1);
  }
  return dates;
}

export async function listAvailabilityForProperty(propertyId: string) {
  const result = await db.query(
    `SELECT date, status, source FROM availability_blocks
     WHERE property_id = $1 AND date >= CURRENT_DATE
     ORDER BY date`,
    [propertyId]
  );
  // FOUND via a real, reproduced bug report: node-postgres returns a
  // DATE column as a native JS Date object, not a string (confirmed
  // directly — SELECT '2026-12-04'::date comes back as an actual Date
  // instance). NextResponse.json()'s underlying JSON.stringify() then
  // serializes that Date to a FULL ISO timestamp —
  // "2026-12-04T00:00:00.000Z" — not the plain "2026-12-04" the
  // AvailabilityCalendar component's cells are keyed by. A host's real
  // "Blocked 2 dates" action genuinely wrote the correct rows (the block
  // itself always worked), but the calendar's `Set.has(iso)` lookup
  // could never match a timestamp against a plain date, so the grey
  // styling never applied. This exact bug was invisible before the
  // calendar existed: the OLD text-based date-tag display used
  // formatDate(), which already tolerates either shape via its own
  // slice(0,10) — only a strict Set-key lookup exposes the mismatch.
  // Normalizing here, at the source, matches the already-correct
  // pattern in app/api/properties/[id]/availability/route.ts (the
  // guest-facing equivalent), so both availability reads agree on one
  // date format rather than drifting.
  return result.rows.map((row) => ({
    date: row.date instanceof Date ? row.date.toISOString().slice(0, 10) : row.date,
    status: row.status,
    source: row.source,
  }));
}

export type BlockResult = { blocked: string[]; skipped: { date: string; reason: string }[] };

/** Blocks each date in [checkIn, checkOut). A date that's already
 *  genuinely booked (source='booking') is deliberately SKIPPED, not
 *  overwritten — a host cannot manually block over a real booking, and
 *  doing so silently would misrepresent what's actually happening on
 *  that date. */
export async function blockDates(propertyId: string, checkIn: string, checkOut: string): Promise<BlockResult> {
  const dates = enumerateDates(checkIn, checkOut);
  const result: BlockResult = { blocked: [], skipped: [] };

  for (const date of dates) {
    const existing = await db.query(`SELECT status, source FROM availability_blocks WHERE property_id = $1 AND date = $2`, [propertyId, date]);
    if (existing.rows.length > 0 && existing.rows[0].source === "booking") {
      result.skipped.push({ date, reason: "already booked" });
      continue;
    }
    await db.query(
      `INSERT INTO availability_blocks (property_id, date, status, source)
       VALUES ($1, $2, 'blocked', 'host')
       ON CONFLICT (property_id, date) DO UPDATE SET status = 'blocked', source = 'host'`,
      [propertyId, date]
    );
    result.blocked.push(date);
  }
  return result;
}

/** Unblocks each date in [checkIn, checkOut) — but ONLY rows with
 *  source='host'. A source='booking' row is never touched by this
 *  function, structurally: the WHERE clause excludes it, not merely a
 *  convention. */
export async function unblockDates(propertyId: string, checkIn: string, checkOut: string): Promise<BlockResult> {
  const dates = enumerateDates(checkIn, checkOut);
  const result: BlockResult = { blocked: [], skipped: [] };

  for (const date of dates) {
    const existing = await db.query(`SELECT status, source FROM availability_blocks WHERE property_id = $1 AND date = $2`, [propertyId, date]);
    if (existing.rows.length > 0 && existing.rows[0].source === "booking") {
      result.skipped.push({ date, reason: "cannot unblock a real booking" });
      continue;
    }
    await db.query(`DELETE FROM availability_blocks WHERE property_id = $1 AND date = $2 AND source = 'host'`, [propertyId, date]);
    result.blocked.push(date);
  }
  return result;
}
