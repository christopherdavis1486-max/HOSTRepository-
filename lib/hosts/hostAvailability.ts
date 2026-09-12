import { withTransaction } from "../db";
import { hashToBigint } from "../utils/advisoryLock";

type AvailabilityRow = {
  date: string | Date;
  status: string;
  source: string;
};

function normalizeDate(value: string | Date): string {
  return value instanceof Date
    ? value.toISOString().slice(0, 10)
    : String(value).slice(0, 10);
}

function enumerateDates(
  checkIn: string,
  checkOut: string
): string[] {
  const dates: string[] = [];
  const current = new Date(`${checkIn}T00:00:00Z`);
  const end = new Date(`${checkOut}T00:00:00Z`);

  while (current < end) {
    dates.push(current.toISOString().slice(0, 10));
    current.setUTCDate(current.getUTCDate() + 1);
  }

  return dates;
}

export async function listAvailabilityForProperty(
  propertyId: string
) {
  return withTransaction(async (client) => {
    const result = await client.query<AvailabilityRow>(
      `SELECT date, status, source
       FROM availability_blocks
       WHERE property_id = $1
         AND date >= CURRENT_DATE
       ORDER BY date`,
      [propertyId]
    );

    return result.rows.map((row) => ({
      date: normalizeDate(row.date),
      status: row.status,
      source: row.source,
    }));
  });
}

export type BlockResult = {
  blocked: string[];
  skipped: {
    date: string;
    reason: string;
  }[];
};

async function mutateAvailability(
  propertyId: string,
  checkIn: string,
  checkOut: string,
  action: "block" | "unblock"
): Promise<BlockResult> {
  const dates = enumerateDates(checkIn, checkOut);

  return withTransaction(async (client) => {
    /*
     * Booking creation uses this same property-level transaction lock.
     * It serializes every booking, block and unblock operation for one
     * property, including fresh dates for which no row exists yet.
     */
    await client.query(
      `SELECT pg_advisory_xact_lock($1)`,
      [hashToBigint(propertyId)]
    );

    const existingResult =
      await client.query<AvailabilityRow>(
        `SELECT date, status, source
         FROM availability_blocks
         WHERE property_id = $1
           AND date >= $2
           AND date < $3
         FOR UPDATE`,
        [propertyId, checkIn, checkOut]
      );

    const existingByDate = new Map(
      existingResult.rows.map((row) => [
        normalizeDate(row.date),
        row,
      ])
    );

    const result: BlockResult = {
      blocked: [],
      skipped: [],
    };

    for (const date of dates) {
      const existing = existingByDate.get(date);

      if (existing?.source === "booking") {
        result.skipped.push({
          date,
          reason:
            action === "block"
              ? "already booked"
              : "cannot unblock a real booking",
        });
        continue;
      }

      if (existing?.source === "ical_sync") {
        result.skipped.push({
          date,
          reason: "managed by calendar sync",
        });
        continue;
      }

      if (action === "block") {
        await client.query(
          `INSERT INTO availability_blocks (
             property_id,
             date,
             status,
             source
           )
           VALUES ($1, $2, 'blocked', 'host')
           ON CONFLICT (property_id, date)
           DO UPDATE SET
             status = 'blocked',
             source = 'host'
           WHERE availability_blocks.source = 'host'`,
          [propertyId, date]
        );
      } else {
        await client.query(
          `DELETE FROM availability_blocks
           WHERE property_id = $1
             AND date = $2
             AND source = 'host'`,
          [propertyId, date]
        );
      }

      result.blocked.push(date);
    }

    return result;
  });
}

/**
 * Blocks every date in [checkIn, checkOut). Booking and calendar-sync
 * rows are preserved and reported as skipped.
 */
export async function blockDates(
  propertyId: string,
  checkIn: string,
  checkOut: string
): Promise<BlockResult> {
  return mutateAvailability(
    propertyId,
    checkIn,
    checkOut,
    "block"
  );
}

/**
 * Removes only host-created blocks in [checkIn, checkOut). Genuine
 * booking and calendar-sync rows can never be removed by this action.
 */
export async function unblockDates(
  propertyId: string,
  checkIn: string,
  checkOut: string
): Promise<BlockResult> {
  return mutateAvailability(
    propertyId,
    checkIn,
    checkOut,
    "unblock"
  );
}