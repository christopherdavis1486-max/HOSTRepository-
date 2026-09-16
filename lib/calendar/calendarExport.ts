import { db } from "../db";

type ExportPropertyRow = {
  property_id: string;
  property_name: string;
};

type AvailabilityDateRow = {
  date: string | Date;
};

type DateRange = {
  startsOn: string;
  endsOn: string;
};

export type CalendarExport = {
  propertyId: string;
  propertyName: string;
  body: string;
};

function normalizeDate(
  value: string | Date,
): string {
  return value instanceof Date
    ? value.toISOString().slice(0, 10)
    : String(value).slice(0, 10);
}

function addDays(
  value: string,
  days: number,
): string {
  const date = new Date(
    `${value}T00:00:00Z`,
  );

  date.setUTCDate(
    date.getUTCDate() + days,
  );

  return date.toISOString().slice(0, 10);
}

function compactDate(value: string): string {
  return value.replace(/-/g, "");
}

function escapeIcalText(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/\r?\n/g, "\\n")
    .replace(/,/g, "\\,")
    .replace(/;/g, "\\;");
}

function foldLine(line: string): string[] {
  const maximumLength = 73;

  if (line.length <= maximumLength) {
    return [line];
  }

  const folded: string[] = [];
  let remaining = line;
  let first = true;

  while (remaining.length > 0) {
    const width = first
      ? maximumLength
      : maximumLength - 1;

    const chunk = remaining.slice(0, width);
    remaining = remaining.slice(width);

    folded.push(
      first
        ? chunk
        : ` ${chunk}`,
    );

    first = false;
  }

  return folded;
}

function groupConsecutiveDates(
  values: string[],
): DateRange[] {
  if (values.length === 0) {
    return [];
  }

  const dates = [...new Set(values)].sort();
  const ranges: DateRange[] = [];

  let rangeStart = dates[0];
  let previous = dates[0];

  for (const date of dates.slice(1)) {
    if (date === addDays(previous, 1)) {
      previous = date;
      continue;
    }

    ranges.push({
      startsOn: rangeStart,
      endsOn: addDays(previous, 1),
    });

    rangeStart = date;
    previous = date;
  }

  ranges.push({
    startsOn: rangeStart,
    endsOn: addDays(previous, 1),
  });

  return ranges;
}

function buildCalendar(
  propertyId: string,
  propertyName: string,
  ranges: DateRange[],
): string {
  const generatedAt = new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");

  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//HOST//Property Availability//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${escapeIcalText(
      `HOST - ${propertyName}`,
    )}`,
  ];

  for (const range of ranges) {
    lines.push(
      "BEGIN:VEVENT",
      `UID:host-${propertyId}-${range.startsOn}-${range.endsOn}@hostcityliving.com`,
      `DTSTAMP:${generatedAt}`,
      `DTSTART;VALUE=DATE:${compactDate(
        range.startsOn,
      )}`,
      `DTEND;VALUE=DATE:${compactDate(
        range.endsOn,
      )}`,
      "STATUS:CONFIRMED",
      "TRANSP:OPAQUE",
      "SUMMARY:Unavailable",
      "END:VEVENT",
    );
  }

  lines.push("END:VCALENDAR");

  return (
    lines
      .flatMap(foldLine)
      .join("\r\n") +
    "\r\n"
  );
}

export async function generateCalendarExport(
  exportToken: string,
): Promise<CalendarExport | null> {
  const propertyResult =
    await db.query<ExportPropertyRow>(
      `SELECT
         property.id AS property_id,
         property.name AS property_name
       FROM property_calendar_exports export
       INNER JOIN properties property
         ON property.id = export.property_id
       WHERE export.export_token = $1::uuid`,
      [exportToken],
    );

  const property = propertyResult.rows[0];

  if (!property) {
    return null;
  }

  const availabilityResult =
    await db.query<AvailabilityDateRow>(
      `SELECT date
       FROM availability_blocks
       WHERE property_id = $1
         AND date >= CURRENT_DATE
         AND status != 'available'
       ORDER BY date`,
      [property.property_id],
    );

  const ranges = groupConsecutiveDates(
    availabilityResult.rows.map((row) =>
      normalizeDate(row.date),
    ),
  );

  return {
    propertyId: property.property_id,
    propertyName: property.property_name,
    body: buildCalendar(
      property.property_id,
      property.property_name,
      ranges,
    ),
  };
}

export const calendarExportInternals = {
  groupConsecutiveDates,
  buildCalendar,
};