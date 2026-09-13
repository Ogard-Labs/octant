import type { ZenTimerAction, ZenTimerElementPayload } from "@octant/contracts/zen";
import { useEffect, useRef, useState } from "react";
import { OctantButton } from "../../ui/base/OctantButton";
import { scheduleVisibleInterval } from "../../polling/documentVisibility";

export interface ZenTimerProps {
  readonly timer: ZenTimerElementPayload;
  readonly reducedMotion: boolean;
  readonly onAction: (action: ZenTimerAction) => void;
  readonly onElapsed?: () => void;
}

export function ZenTimer({ timer, reducedMotion, onAction, onElapsed }: ZenTimerProps) {
  const [displayRemainingSeconds, setDisplayRemainingSeconds] = useState(() =>
    Math.ceil(timer.remainingMs / 1_000),
  );
  const elapsedReported = useRef(false);

  useEffect(() => {
    elapsedReported.current = false;
    if (timer.status !== "running") {
      setDisplayRemainingSeconds(Math.ceil(timer.remainingMs / 1_000));
      return;
    }

    const deadline = timer.deadlineAt === null ? null : Date.parse(timer.deadlineAt);
    const baselineRemaining =
      deadline === null ? timer.remainingMs : Math.min(timer.remainingMs, deadline - Date.now());
    const monotonicStartedAt = performance.now();
    const update = () => {
      const monotonicRemaining = Math.max(
        0,
        baselineRemaining - (performance.now() - monotonicStartedAt),
      );
      const next =
        deadline === null
          ? monotonicRemaining
          : Math.max(0, Math.min(monotonicRemaining, deadline - Date.now()));
      const nextSeconds = Math.ceil(next / 1_000);
      // The face shows whole seconds; a quarter-second tick that changes no
      // digit should not re-render the widget.
      setDisplayRemainingSeconds((current) => (current === nextSeconds ? current : nextSeconds));
      if (next === 0 && !elapsedReported.current) {
        elapsedReported.current = true;
        onElapsed?.();
      }
    };
    update();
    // Hidden windows do not need a running timer face; becoming visible ticks
    // once so the face is correct before the person sees it.
    return scheduleVisibleInterval(update, reducedMotion ? 1_000 : 250);
  }, [
    onElapsed,
    reducedMotion,
    timer.deadlineAt,
    timer.elementId,
    timer.remainingMs,
    timer.startedAt,
    timer.status,
  ]);

  const roundedSeconds = displayRemainingSeconds;
  const minutes = Math.floor(roundedSeconds / 60);
  const seconds = roundedSeconds % 60;
  const statusLabel =
    timer.status === "completed"
      ? "Timer complete"
      : timer.status === "running"
        ? "Running"
        : timer.status === "paused"
          ? "Paused"
          : "Ready";

  return (
    <section
      className={`zen-timer${reducedMotion ? " zen-timer--reduced-motion" : ""}`}
      data-status={timer.status}
    >
      <div aria-label={remainingLabel(roundedSeconds)} className="zen-timer-clock" role="timer">
        {minutes.toString().padStart(2, "0")}:{seconds.toString().padStart(2, "0")}
      </div>
      <div
        aria-label="Timer status"
        aria-live="polite"
        aria-atomic="true"
        className="zen-timer-status"
        role="status"
      >
        {statusLabel}
      </div>
      <div aria-label="Timer controls" className="zen-timer-acts" role="group">
        {timer.status === "running" ? (
          <OctantButton
            aria-label="Pause timer"
            onClick={() => onAction("pause")}
            size="sm"
            type="button"
            variant="secondary"
          >
            Pause
          </OctantButton>
        ) : timer.status === "completed" ? null : (
          <OctantButton
            aria-label="Start timer"
            onClick={() => onAction("start")}
            size="sm"
            type="button"
            variant="secondary"
          >
            Start
          </OctantButton>
        )}
        <OctantButton
          aria-label="Reset timer"
          disabled={timer.status === "idle" && timer.remainingMs === timer.durationMs}
          onClick={() => onAction("reset")}
          size="sm"
          type="button"
          variant="ghost"
        >
          Reset
        </OctantButton>
      </div>
    </section>
  );
}

function remainingLabel(totalSeconds: number): string {
  if (totalSeconds === 0) return "No time remaining";
  if (totalSeconds % 60 === 0) {
    const minutes = totalSeconds / 60;
    return `${minutes} ${minutes === 1 ? "minute" : "minutes"} remaining`;
  }
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes} minutes ${seconds} seconds remaining`;
}
