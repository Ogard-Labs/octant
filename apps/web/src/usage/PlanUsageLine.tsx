import { Fragment } from "react";
import type { ComposerLimitWindow } from "../context/composerLimitWindows";
import { OctantTooltip } from "../ui/base/OctantTooltip";
import { resetCountdown, windowHours } from "./railUsageReading";
import "./plan-usage-line.css";

/** "5-hour limit" read as the window it is: "5-hour window". */
function windowName(window: ComposerLimitWindow): string {
  return window.name.replace(/ limit\b/, " window");
}

/**
 * What a part says in words, for its tooltip and accessible name. The words
 * carry the standing, so the warning ink is never the only sign.
 */
function partLabel(window: ComposerLimitWindow, countdown: string | undefined): string {
  const standing =
    window.level === "spent"
      ? "limit reached"
      : window.level === "near"
        ? `${String(window.percent)}% left, close to its limit`
        : `${String(window.percent)}% left`;
  return `${windowName(window)}: ${standing}${countdown === undefined ? "" : `, resets in ${countdown}`}`;
}

/**
 * How much of the plan is left, as one quiet line of text: every window the
 * provider reported, each with the share left and the time to its reset
 * ("100% 4h 59m · 70% 1d 19h"). It is text, not a bar, so it reads the same at
 * any width and never shifts the controls beside it while the numbers tick
 * (tabular figures). A window close to its limit takes the warning ink and a
 * spent one the danger ink, and each part's tooltip and accessible name say
 * which window it is and its standing in words. Nothing renders without a
 * window, because a figure nobody reported would be invented.
 */
export function PlanUsageLine(props: {
  readonly windows: ReadonlyArray<ComposerLimitWindow>;
  /** When each window resets, by window id, where the provider said. */
  readonly resetsAt: ReadonlyMap<string, string>;
  readonly now: number;
}) {
  if (props.windows.length === 0) return null;
  // Shortest window first, whatever order the provider listed them in.
  const windows = [...props.windows].sort((a, b) => windowHours(a.window) - windowHours(b.window));
  return (
    <span aria-label="Plan usage left" className="plan-usage-line" role="group">
      {windows.map((window, index) => {
        const countdown = resetCountdown(props.resetsAt.get(window.window), props.now);
        const label = partLabel(window, countdown);
        return (
          <Fragment key={window.window}>
            {index === 0 ? null : (
              <span aria-hidden="true" className="plan-usage-line__sep">
                {" · "}
              </span>
            )}
            <OctantTooltip label={label} side="top">
              <span
                aria-label={label}
                className="plan-usage-line__part"
                data-level={window.level}
                role="img"
              >
                {`${String(window.percent)}%${countdown === undefined ? "" : ` ${countdown}`}`}
              </span>
            </OctantTooltip>
          </Fragment>
        );
      })}
    </span>
  );
}
