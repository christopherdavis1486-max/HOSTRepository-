/**
 * Extracted from components/AvailabilityCalendar.tsx specifically to
 * make "does this date render as manually blocked / booked / available"
 * directly testable without a browser. This is the exact logic that,
 * combined with a real Date-object-vs-string mismatch upstream in
 * lib/hosts/hostAvailability.ts, produced the reported bug: the
 * classification logic itself was always correct — it was being fed
 * Set contents that could never match a calendar cell's plain-date key.
 * Extracting this doesn't fix that bug on its own, but it's what lets a
 * test prove the FULL pipeline (real data -> real Set construction ->
 * real classification) actually produces "host-blocked" for a genuinely
 * blocked date, rather than only asserting the SQL or the component
 * looks right in isolation.
 */

export type DayClassification = {
  isPast: boolean;
  isHostBlocked: boolean;
  isBooked: boolean;
  isDisabled: boolean;
  isSelected: boolean;
  inRange: boolean;
  classes: string[];
  clickable: boolean;
};

export function classifyDay(
  iso: string,
  opts: {
    todayIso: string;
    hostBlockedDates: Set<string>;
    bookedDates: Set<string>;
    disabledDates: Set<string>;
    checkIn?: string;
    checkOut?: string;
    interactive: boolean;
    hasSelectHandler: boolean;
  }
): DayClassification {
  const isPast = iso < opts.todayIso;
  const isHostBlocked = opts.hostBlockedDates.has(iso);
  const isBooked = opts.bookedDates.has(iso);
  const isDisabled = opts.disabledDates.has(iso);
  const isSelected = iso === opts.checkIn || iso === opts.checkOut;
  const inRange = !!opts.checkIn && !!opts.checkOut && iso > opts.checkIn && iso < opts.checkOut;

  const classes = ["cal-day"];
  if (isPast) classes.push("past");
  else if (isHostBlocked) classes.push("host-blocked");
  else if (isBooked) classes.push("booked");
  else if (isDisabled) classes.push("disabled");
  if (isSelected) classes.push("selected");
  if (inRange) classes.push("in-range");

  const clickable = opts.interactive && !isPast && !isHostBlocked && !isBooked && !isDisabled && opts.hasSelectHandler;

  return { isPast, isHostBlocked, isBooked, isDisabled, isSelected, inRange, classes, clickable };
}
