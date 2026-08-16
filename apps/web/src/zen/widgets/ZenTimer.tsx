import type { ZenTimerAction, ZenTimerElementPayload } from "@octant/contracts/zen";
import { useEffect, useRef, useState } from "react";
import { OctantButton } from "../../ui/base/OctantButton";

export interface ZenTimerProps {
  readonly timer: ZenTimerElementPayload;
  readonly reducedMotion: boolean;
  readonly onAction: (action: ZenTimerAction) => void;
  readonly onElapsed?: () => void;
}

export function ZenTimer({ timer, reducedMotion, onAction, onElapsed }: ZenTimerProps) {
  const [displayRemainingMs, setDisplayRemainingMs] = useState(timer.remainingMs);
  const elapsedReported = useRef(false);

  useEffect(() => {
    elapsedReported.current = false;
    if (timer.status !== "running") {
      setDisplayRemainingMs(timer.remainingMs);
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
      setDisplayRemainingMs(next);
      if (next === 0 && !elapsedReported.current) {
        elapsedReported.current = true;
        onElapsed?.();
      }
    };
    update();
    const interval = setInterval(update, reducedMotion ? 1_000 : 250);
    document.addEventListener("visibilitychange", update);
    return () => {
      clearInterval(interval);
      document.removeEventListener("visibilitychange", update);
    };
  }, [
    onElapsed,
    reducedMotion,
    timer.deadlineAt,
    timer.elementId,
    timer.remainingMs,
    timer.startedAt,
    timer.status,
  ]);

  const roundedSeconds = Math.ceil(displayRemainingMs / 1_000);
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
    <section className={`zen-timer${reducedMotion ? " zen-timer--reduced-motion" : ""}`}>
      <div aria-label={remainingLabel(roundedSeconds)} className="zen-timer__time" role="timer">
        {minutes.toString().padStart(2, "0")}:{seconds.toString().padStart(2, "0")}
      </div>
      <div
        aria-label="Timer status"
        aria-live="polite"
        aria-atomic="true"
        className={`zen-timer__status zen-timer__status--${timer.status}`}
        role="status"
      >
        {statusLabel}
      </div>
      <div aria-label="Timer controls" className="zen-timer__controls" role="group">
        {timer.status === "running" ? (
          <OctantButton
            aria-label="Pause timer"
            onClick={() => onAction("pause")}
            type="button"
            variant="secondary"
          >
            Pause
          </OctantButton>
        ) : timer.status === "completed" ? null : (
          <OctantButton
            aria-label="Start timer"
            onClick={() => onAction("start")}
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
