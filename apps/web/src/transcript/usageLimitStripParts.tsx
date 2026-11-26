import { useEffect, useState } from "react";
import type { ProviderUsageLimit, UsageResumeThreadState } from "@octant/contracts";
import { OctantButton } from "../ui/base/OctantButton";
import { resetClock } from "./resetClock";
import type { UsageLimitStripInput } from "./usageLimitStrip";
import "./usage-limit-strip.css";

// The strip's line and its actions, loaded with the first strip a thread
// shows rather than with the window: a usage limit is rare, and the initial
// renderer has no room for code that most sessions never draw.

const KIND_LABEL: Record<ProviderUsageLimit["kind"], string> = {
  temporary: "Rate limit",
  exhausted: "Usage limit",
  billing: "Billing problem",
};

/** "in 42 min", "in 2 hr 5 min", or "now" once the time has come. */
export function resetDistance(resetsAt: string, now: number): string {
  const minutes = Math.ceil((new Date(resetsAt).getTime() - now) / 60_000);
  if (minutes <= 0) return "now";
  if (minutes < 60) return `in ${String(minutes)} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `in ${String(hours)} hr` : `in ${String(hours)} hr ${String(rest)} min`;
}

const resetIsAhead = (
  limit: ProviderUsageLimit,
  now: number,
): limit is ProviderUsageLimit & {
  readonly resetsAt: string;
} =>
  limit.kind !== "billing" &&
  limit.resetsAt !== undefined &&
  new Date(limit.resetsAt).getTime() > now;

function settledDetail(resume: UsageResumeThreadState): string | undefined {
  switch (resume.status) {
    case "invalidated":
      return resume.detail === undefined
        ? "The scheduled resume no longer applies"
        : `The scheduled resume no longer applies: ${resume.detail}`;
    case "failed":
      return resume.detail === undefined
        ? "The scheduled resume could not start"
        : `The scheduled resume could not start: ${resume.detail}`;
    case "scheduled":
    case "dispatched":
      return undefined;
  }
}

/**
 * The words of the line. A billing stop names the problem and nothing else:
 * an account in arrears does not free up on a clock. An unknown reset says
 * so rather than inventing a countdown.
 */
export function usageLimitStripText(input: {
  readonly limit: ProviderUsageLimit;
  readonly provider: string;
  readonly usageResume?: UsageResumeThreadState | undefined;
  readonly now: number;
}): string {
  const parts = [input.provider, KIND_LABEL[input.limit.kind]];
  if (input.limit.kind !== "billing") {
    const resume = input.usageResume;
    if (resume?.status === "scheduled") {
      const when = resetClock(resume.record.resetsAt, input.now);
      // A resume the person's default armed says so, so it never reads as a
      // choice they made on this stop.
      parts.push(
        resume.record.origin === "default" ? `Resumes at ${when} (default)` : `Resumes at ${when}`,
      );
    } else if (input.limit.resetsAt === undefined) {
      parts.push("reset time not given");
    } else {
      parts.push(
        `resets ${resetClock(input.limit.resetsAt, input.now)} · ${resetDistance(input.limit.resetsAt, input.now)}`,
      );
    }
    const detail = resume === undefined ? undefined : settledDetail(resume);
    if (detail !== undefined) parts.push(detail);
  }
  return parts.join(" · ");
}

/**
 * The time a strip part reads. A part given a fixed `now` (tests) keeps it;
 * otherwise it moves every 30 seconds and once more the moment the reset
 * arrives, so a countdown and the offers that need a reset still ahead never
 * outlive it while the strip sits parked above the composer.
 */
function useStripNow(fixed: number | undefined, resetsAt: string | undefined): number {
  const [tick, setTick] = useState(() => Date.now());
  const counting = fixed === undefined && resetsAt !== undefined;
  useEffect(() => {
    if (!counting || resetsAt === undefined) return;
    const timer = setInterval(() => setTick(Date.now()), 30_000);
    const untilReset = new Date(resetsAt).getTime() - Date.now();
    const atReset =
      untilReset > 0 && untilReset < 2_147_483_647
        ? setTimeout(() => setTick(Date.now()), untilReset + 1)
        : undefined;
    return () => {
      clearInterval(timer);
      if (atReset !== undefined) clearTimeout(atReset);
    };
  }, [counting, resetsAt]);
  return fixed ?? tick;
}

const clockedReset = (limit: ProviderUsageLimit): string | undefined =>
  limit.kind === "billing" ? undefined : limit.resetsAt;

/** The line itself, kept moving while it sits above the composer. */
export function UsageLimitStripLine(props: {
  readonly limit: ProviderUsageLimit;
  readonly provider: string;
  readonly usageResume?: UsageResumeThreadState | undefined;
  readonly now?: number | undefined;
}) {
  const now = useStripNow(props.now, clockedReset(props.limit));
  return (
    <span className="usage-limit-strip">
      {usageLimitStripText({
        limit: props.limit,
        provider: props.provider,
        usageResume: props.usageResume,
        now,
      })}
    </span>
  );
}

/**
 * The strip's ways on, decided against the moving clock: Resume at reset and
 * Snooze leave the moment the reset passes, since the host would refuse both.
 */
export function UsageLimitStripActions(props: { readonly input: UsageLimitStripInput }) {
  const input = props.input;
  const now = useStripNow(input.now, clockedReset(input.limit));
  // A billing stop offers nothing: no clock clears it, and nothing to resume.
  if (input.limit.kind === "billing") return null;
  const resume = input.usageResume;
  const ahead = resetIsAhead(input.limit, now);
  const scheduled = resume?.status === "scheduled";
  const dispatched = resume?.status === "dispatched";
  const actions = [
    !dispatched && input.onResumeNow !== undefined ? (
      <OctantButton key="now" onClick={input.onResumeNow} size="sm" type="button">
        Resume now
      </OctantButton>
    ) : null,
    scheduled && input.onCancelResume !== undefined ? (
      <OctantButton key="cancel" onClick={input.onCancelResume} size="sm" type="button">
        Cancel resume
      </OctantButton>
    ) : ahead && !scheduled && !dispatched && input.onScheduleResume !== undefined ? (
      <OctantButton key="at-reset" onClick={input.onScheduleResume} size="sm" type="button">
        Resume at reset
      </OctantButton>
    ) : null,
    ahead && !dispatched && input.onSnoozeAtReset !== undefined ? (
      <OctantButton key="snooze" onClick={input.onSnoozeAtReset} size="sm" type="button">
        Snooze until reset
      </OctantButton>
    ) : null,
  ].filter((action) => action !== null);
  return actions.length === 0 ? null : (
    <span className="usage-limit-strip__actions">{actions}</span>
  );
}
