import type { AutomationSummary } from "@octant/contracts";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { useMemo } from "react";
import { OctantIconButton } from "../ui/base/OctantButton";
import { buildRoutineCalendarMonth, stepRoutineCalendarMonth } from "./routineCalendar";

const WEEKDAY_HEADINGS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;

/**
 * The same routines, laid out by when they run.
 *
 * A list answers "what do I have"; this answers "what is my week". It shows
 * the routines already narrowed by the search and filters above it, so the two
 * views never disagree about which routines exist — they only differ in how
 * they are arranged.
 */
export function RoutineCalendar(props: {
  readonly routines: ReadonlyArray<AutomationSummary>;
  readonly month: string;
  readonly now: string;
  readonly timeZone: string;
  readonly onMonthChange: (month: string) => void;
  readonly onSelect: (automationId: string) => void;
}) {
  const month = useMemo(
    () =>
      buildRoutineCalendarMonth({
        routines: props.routines,
        month: props.month,
        now: props.now,
        timeZone: props.timeZone,
      }),
    [props.routines, props.month, props.now, props.timeZone],
  );

  return (
    <section aria-label="Routine calendar" className="routine-calendar">
      <header className="routine-calendar__header">
        <OctantIconButton
          label="Previous month"
          onClick={() =>
            props.onMonthChange(stepRoutineCalendarMonth(props.month, -1, props.timeZone))
          }
          type="button"
        >
          <ChevronLeft aria-hidden="true" size={14} strokeWidth={1.8} />
        </OctantIconButton>
        <h3 className="routine-calendar__month">{month.label}</h3>
        <OctantIconButton
          label="Next month"
          onClick={() =>
            props.onMonthChange(stepRoutineCalendarMonth(props.month, 1, props.timeZone))
          }
          type="button"
        >
          <ChevronRight aria-hidden="true" size={14} strokeWidth={1.8} />
        </OctantIconButton>
      </header>

      <div aria-hidden="true" className="routine-calendar__weekdays">
        {WEEKDAY_HEADINGS.map((weekday) => (
          <span key={weekday}>{weekday}</span>
        ))}
      </div>

      <div className="routine-calendar__grid">
        {month.weeks.flat().map((day) => (
          <div
            className="routine-calendar__day"
            data-in-month={day.inMonth ? "true" : "false"}
            data-today={day.isToday ? "true" : "false"}
            key={day.date}
          >
            <span className="routine-calendar__day-number">{day.dayOfMonth}</span>
            <ul className="routine-calendar__entries">
              {day.entries.map((entry) => (
                <li key={`${entry.automationId}-${entry.at ?? day.date}`}>
                  <button
                    className="routine-calendar__entry"
                    onClick={() => props.onSelect(entry.automationId)}
                    type="button"
                  >
                    <span className="routine-calendar__entry-time">{entry.label}</span>
                    <span className="routine-calendar__entry-name">{entry.displayName}</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>

      {month.truncated ? (
        <p className="routine-calendar__note" role="status">
          Some routines run more often than this month can show. Their rows in the list say how
          often.
        </p>
      ) : null}
    </section>
  );
}
