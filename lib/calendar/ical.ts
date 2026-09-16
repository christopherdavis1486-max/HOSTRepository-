const MAX_ICAL_BYTES = 2 * 1024 * 1024;
const MAX_ICAL_EVENTS = 5000;

export type CalendarEvent = {
  eventKey: string;
  externalUid: string;
  startsOn: string;
  endsOn: string;
  summary: string | null;
};

export class CalendarParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CalendarParseError";
  }
}

function unfoldLines(source: string): string[] {
  const physicalLines = source
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split("\n");

  const unfolded: string[] = [];

  for (const line of physicalLines) {
    if (
      (line.startsWith(" ") || line.startsWith("\t")) &&
      unfolded.length > 0
    ) {
      unfolded[unfolded.length - 1] += line.slice(1);
      continue;
    }

    unfolded.push(line);
  }

  return unfolded;
}

function splitContentLine(line: string): {
  name: string;
  value: string;
} {
  const separator = line.indexOf(":");

  if (separator < 1) {
    return {
      name: "",
      value: "",
    };
  }

  const property = line.slice(0, separator);
  const parameterSeparator = property.indexOf(";");

  return {
    name: (
      parameterSeparator === -1
        ? property
        : property.slice(0, parameterSeparator)
    ).toUpperCase(),
    value: line.slice(separator + 1),
  };
}

function isRealDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }

  const parsed = new Date(`${value}T00:00:00Z`);

  return (
    !Number.isNaN(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === value
  );
}

function parseCalendarDate(
  value: string,
  fieldName: string,
): string {
  const compactDate = value.trim().slice(0, 8);

  if (!/^\d{8}$/.test(compactDate)) {
    throw new CalendarParseError(
      `${fieldName} must contain a valid iCalendar date`,
    );
  }

  const date = [
    compactDate.slice(0, 4),
    compactDate.slice(4, 6),
    compactDate.slice(6, 8),
  ].join("-");

  if (!isRealDate(date)) {
    throw new CalendarParseError(
      `${fieldName} contains an invalid calendar date`,
    );
  }

  return date;
}

function unescapeText(value: string): string {
  return value
    .replace(/\\n/gi, " ")
    .replace(/\\,/g, ",")
    .replace(/\\;/g, ";")
    .replace(/\\\\/g, "\\")
    .trim();
}

function compareDates(
  left: string,
  right: string,
): number {
  return left.localeCompare(right);
}

type PendingEvent = {
  uid?: string;
  recurrenceId?: string;
  startsOn?: string;
  endsOn?: string;
  summary?: string;
  status?: string;
  recurring: boolean;
};

function finishEvent(
  event: PendingEvent,
): CalendarEvent | null {
  if (event.status?.toUpperCase() === "CANCELLED") {
    return null;
  }

  if (event.recurring) {
    throw new CalendarParseError(
      "Recurring calendar events are not supported; export a booking calendar containing individual reservations",
    );
  }

  const externalUid = unescapeText(event.uid ?? "");

  if (!externalUid) {
    throw new CalendarParseError(
      "A calendar event is missing UID",
    );
  }

  if (externalUid.length > 500) {
    throw new CalendarParseError(
      "A calendar event UID is too long",
    );
  }

  if (!event.startsOn || !event.endsOn) {
    throw new CalendarParseError(
      `Calendar event ${externalUid} must include DTSTART and DTEND`,
    );
  }

  if (compareDates(event.endsOn, event.startsOn) <= 0) {
    throw new CalendarParseError(
      `Calendar event ${externalUid} must end after it starts`,
    );
  }

  const recurrenceId = unescapeText(
    event.recurrenceId ?? "",
  );

  const eventKey = recurrenceId
    ? `${externalUid}::${recurrenceId}`
    : externalUid;

  if (eventKey.length > 500) {
    throw new CalendarParseError(
      "A calendar event key is too long",
    );
  }

  const summary = unescapeText(event.summary ?? "");

  return {
    eventKey,
    externalUid,
    startsOn: event.startsOn,
    endsOn: event.endsOn,
    summary: summary
      ? summary.slice(0, 300)
      : null,
  };
}

export function parseICalendar(
  source: string,
): CalendarEvent[] {
  if (
    Buffer.byteLength(source, "utf8") >
    MAX_ICAL_BYTES
  ) {
    throw new CalendarParseError(
      "Calendar file is larger than 2 MB",
    );
  }

  const lines = unfoldLines(source);

  if (
    !lines.some(
      (line) =>
        line.trim().toUpperCase() ===
        "BEGIN:VCALENDAR",
    )
  ) {
    throw new CalendarParseError(
      "The response is not an iCalendar file",
    );
  }

  const events = new Map<string, CalendarEvent>();
  let pending: PendingEvent | null = null;

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    const marker = line.trim().toUpperCase();

    if (marker === "BEGIN:VEVENT") {
      if (pending) {
        throw new CalendarParseError(
          "Nested calendar events are invalid",
        );
      }

      pending = {
        recurring: false,
      };

      continue;
    }

    if (marker === "END:VEVENT") {
      if (!pending) {
        throw new CalendarParseError(
          "Calendar event ended without beginning",
        );
      }

      const completed = finishEvent(pending);
      pending = null;

      if (!completed) {
        continue;
      }

      events.set(completed.eventKey, completed);

      if (events.size > MAX_ICAL_EVENTS) {
        throw new CalendarParseError(
          "Calendar contains more than 5,000 events",
        );
      }

      continue;
    }

    if (!pending) {
      continue;
    }

    const { name, value } = splitContentLine(line);

    switch (name) {
      case "UID":
        pending.uid = value;
        break;

      case "RECURRENCE-ID":
        pending.recurrenceId = value;
        break;

      case "DTSTART":
        pending.startsOn = parseCalendarDate(
          value,
          "DTSTART",
        );
        break;

      case "DTEND":
        pending.endsOn = parseCalendarDate(
          value,
          "DTEND",
        );
        break;

      case "SUMMARY":
        pending.summary = value;
        break;

      case "STATUS":
        pending.status = value;
        break;

      case "RRULE":
      case "RDATE":
        pending.recurring = true;
        break;

      default:
        break;
    }
  }

  if (pending) {
    throw new CalendarParseError(
      "Calendar event is missing END:VEVENT",
    );
  }

  return [...events.values()].sort((left, right) => {
    const dateOrder = compareDates(
      left.startsOn,
      right.startsOn,
    );

    return dateOrder !== 0
      ? dateOrder
      : left.eventKey.localeCompare(right.eventKey);
  });
}