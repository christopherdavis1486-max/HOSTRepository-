"use client";

import { useState } from "react";
import { classifyDay } from "./calendarClassification";
import { useGuestI18n } from "@/lib/i18n/useGuestI18n";
import { LOCALE_TAGS } from "@/lib/i18n/config";

/**
 * Shared, dependency-free calendar foundation for BOTH the guest
 * booking date-selector and the host availability view (item 6's own
 * suggestion: "use the same reusable calendar foundation for the host
 * availability interface" — this is that shared piece, not two separate
 * implementations). No new npm package — a month-grid built from plain
 * Date arithmetic, matching the project's established preference for
 * small, dependency-free UI over pulling in a calendar library for a
 * fairly bounded need.
 *
 * Deliberately dumb about WHAT a date means — it only knows "disabled or
 * not" plus an optional colour category per date, driven entirely by
 * props. Availability RULES themselves stay exactly where they already
 * correctly live (the server/database) — this component never decides
 * whether a date is really available, it only renders what it's told.
 */

export type DayStatus = "available" | "unavailable" | "host-blocked" | "booked" | "past" | "selected" | "in-range";

type CalendarProps = {
  monthsToShow?: number;
  today?: Date;
  disabledDates?: Set<string>;
  hostBlockedDates?: Set<string>;
  bookedDates?: Set<string>;
  checkIn?: string;
  checkOut?: string;
  onSelectDate?: (isoDate: string) => void;
  interactive?: boolean;
};

function toIso(d: Date): string {
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function daysInMonth(year: number, month: number): number {
  return new Date(year, month + 1, 0).getDate();
}

export function AvailabilityCalendar({
  monthsToShow = 2,
  today = new Date(),
  disabledDates = new Set(),
  hostBlockedDates = new Set(),
  bookedDates = new Set(),
  checkIn,
  checkOut,
  onSelectDate,
  interactive = true,
}: CalendarProps) {
  const { locale, gt } = useGuestI18n();
  const [viewOffset, setViewOffset] = useState(0);
  const todayIso = toIso(today);
  const weekdayLabels = locale === "de"
    ? ["So", "Mo", "Di", "Mi", "Do", "Fr", "Sa"]
    : locale === "fr"
      ? ["Di", "Lu", "Ma", "Me", "Je", "Ve", "Sa"]
      : locale === "es"
        ? ["Do", "Lu", "Ma", "Mi", "Ju", "Vi", "Sá"]
        : locale === "it"
          ? ["Do", "Lu", "Ma", "Me", "Gi", "Ve", "Sa"]
          : locale === "nl"
            ? ["Zo", "Ma", "Di", "Wo", "Do", "Vr", "Za"]
      : ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];

  const months = Array.from({ length: monthsToShow }, (_, i) => {
    const base = new Date(today.getFullYear(), today.getMonth() + viewOffset + i, 1);
    return { year: base.getFullYear(), month: base.getMonth() };
  });


  return (
    <div className="avail-calendar">
      <style>{`
        .avail-calendar { --cal-ink: #14120E; --cal-graphite: #1F1B15; --cal-stone: #2A251C; --cal-ivory: #F2ECDE; --cal-warm-grey: #A79E8C; --cal-brass: #C9974B; --cal-gold: #C9974B; --cal-grey: #6B6456; }
        .avail-calendar { font-family: 'Space Grotesk', system-ui, sans-serif; }
        .cal-nav { display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px; }
        .cal-nav button { background: transparent; border: 1px solid var(--cal-stone); color: var(--cal-ivory); border-radius: 4px; padding: 6px 10px; cursor: pointer; font-size: 13px; }
        .cal-months { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 20px; }
        .cal-month-title { font-size: 13px; color: var(--cal-warm-grey); margin-bottom: 8px; text-align: center; }
        .cal-grid { display: grid; grid-template-columns: repeat(7, 1fr); gap: 3px; }
        .cal-dow { font-size: 10px; color: var(--cal-warm-grey); text-align: center; padding-bottom: 4px; }
        .cal-day { aspect-ratio: 1; display: flex; align-items: center; justify-content: center; font-size: 12px; border-radius: 4px; cursor: pointer; background: var(--cal-graphite); color: var(--cal-ivory); border: 1px solid transparent; }
        .cal-day.empty { visibility: hidden; cursor: default; }
        .cal-day.past, .cal-day.disabled { color: var(--cal-warm-grey); opacity: 0.35; cursor: not-allowed; text-decoration: line-through; }
        .cal-day.host-blocked { background: var(--cal-grey); color: var(--cal-ivory); cursor: default; }
        .cal-day.booked { background: var(--cal-gold); color: var(--cal-ink); font-weight: 600; cursor: default; }
        .cal-day.selected { background: var(--cal-brass); color: var(--cal-ink); font-weight: 600; border-color: var(--cal-brass); }
        .cal-day.in-range { background: rgba(201,151,75,0.18); }
        .cal-day:not(.empty):not(.past):not(.disabled):not(.host-blocked):not(.booked):hover { border-color: var(--cal-brass); }
        .cal-legend { display: flex; gap: 16px; margin-top: 12px; font-size: 11px; color: var(--cal-warm-grey); flex-wrap: wrap; }
        .cal-legend-item { display: flex; align-items: center; gap: 5px; }
        .cal-legend-swatch { width: 10px; height: 10px; border-radius: 2px; display: inline-block; }
      `}</style>

      <div className="cal-nav">
        <button type="button" onClick={() => setViewOffset((o) => o - 1)} disabled={viewOffset <= 0}>← {gt("previous")}</button>
        <button type="button" onClick={() => setViewOffset((o) => o + 1)}>{gt("next")} →</button>
      </div>

      <div className="cal-months">
        {months.map(({ year, month }) => {
          const firstDay = new Date(year, month, 1).getDay();
          const numDays = daysInMonth(year, month);
          const cells: (string | null)[] = [...Array(firstDay).fill(null), ...Array.from({ length: numDays }, (_, i) => toIso(new Date(year, month, i + 1)))];

          return (
            <div key={`${year}-${month}`}>
              <div className="cal-month-title">{new Date(year, month, 1).toLocaleDateString(LOCALE_TAGS[locale], { month: "long", year: "numeric" })}</div>
              <div className="cal-grid">
                {weekdayLabels.map((d, i) => <div className="cal-dow" key={i}>{d}</div>)}
                {cells.map((iso, i) => {
                  if (!iso) return <div className="cal-day empty" key={i} />;
                  const { classes, clickable } = classifyDay(iso, {
                    todayIso, hostBlockedDates, bookedDates, disabledDates, checkIn, checkOut,
                    interactive, hasSelectHandler: !!onSelectDate,
                  });
                  return (
                    <div key={iso} className={classes.join(" ")} onClick={clickable ? () => onSelectDate!(iso) : undefined}>
                      {Number(iso.slice(8, 10))}
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>

      <div className="cal-legend">
        <span className="cal-legend-item"><span className="cal-legend-swatch" style={{ background: "var(--cal-grey)" }} /> {gt("manuallyBlocked")}</span>
        <span className="cal-legend-item"><span className="cal-legend-swatch" style={{ background: "var(--cal-gold)" }} /> {gt("bookedByGuest")}</span>
        <span className="cal-legend-item"><span className="cal-legend-swatch" style={{ background: "var(--cal-graphite)", border: "1px solid var(--cal-stone)" }} /> {gt("available")}</span>
      </div>
    </div>
  );
}
