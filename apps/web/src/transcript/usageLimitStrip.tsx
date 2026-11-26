import { useEffect, useState } from "react";
import type { ProviderUsageLimit, UsageResumeThreadState } from "@octant/contracts";
import type { ComposerNoticeItem } from "../composer/ComposerNotice";
import { OctantButton } from "../ui/base/OctantButton";

/**
 * The one line above a thread's composer while a provider's usage limit holds
 * its latest turn: who stopped it, when the limit resets, and the three ways
 * on. It replaces the tall alert the transcript used to carry, which pushed
 * the conversation up and repeated itself in Code. The transcript keeps a
 * one-line record of the stop; the actions live only here, beside the box
 * the next message goes into.
 *
 * The caller hands it over only while the stop is current (the thread's
 * latest turn, still waiting on the limit); once the turn is released the
 * strip is gone.
 */
export interface UsageLimitStripInput {
  readonly limit: ProviderUsageLimit;
  /** "Codex — luna" style label so the line names who stopped the turn. */
  readonly provider: string;
  /** The thread's resume record, when it names this stop. */
  readonly usageResume?: UsageResumeThreadState | undefined;
  /** Sends the stopped turn again now, as the person, through ordinary admission. */
  readonly onResumeNow?: (() => void) | undefined;
  readonly onScheduleResume?: (() => void) | undefined;
  readonly onCancelResume?: (() => void) | undefined;
  /** Withheld by the caller once the thread carries a snooze of its own. */
  readonly onSnoozeAtReset?: (() => void) | undefined;
  readonly now?: number;
}

const KIND_LABEL: Record<ProviderUsageLimit["kind"], string> = {
  temporary: "Rate limit",
  exhausted: "Usage limit",
  billing: "Billing problem",
};

const clockFormat = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
const dayClockFormat = new Intl.DateTimeFormat(undefined, {
  weekday: "short",
  hour: "numeric",
  minute: "2-digit",
});

/** "3:40 PM", or "Tue 3:40 PM" when the reset is a day or more away. */
export function resetClock(resetsAt: string, now: number): string {
  const at = new Date(resetsAt).getTime();
  return (at - now >= 24 * 60 * 60_000 ? dayClockFormat : clockFormat).format(new Date(at));
}

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
      parts.push(`Resumes at ${resetClock(resume.record.resetsAt, input.now)}`);
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

/** The line itself, kept moving while it sits above the composer. */
function UsageLimitStripLine(props: {
  readonly limit: ProviderUsageLimit;
  readonly provider: string;
  readonly usageResume?: UsageResumeThreadState | undefined;
  readonly now?: number | undefined;
}) {
  const [tick, setTick] = useState(() => Date.now());
  const counting = props.now === undefined && props.limit.kind !== "billing";
  useEffect(() => {
    if (!counting) return;
    const timer = setInterval(() => setTick(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, [counting]);
  return (
    <span className="usage-limit-strip">
      {usageLimitStripText({
        limit: props.limit,
        provider: props.provider,
        usageResume: props.usageResume,
        now: props.now ?? tick,
      })}
    </span>
  );
}

export function usageLimitStripNotice(input: UsageLimitStripInput): ComposerNoticeItem {
  const now = input.now ?? Date.now();
  const resume = input.usageResume;
  const billing = input.limit.kind === "billing";
  const ahead = resetIsAhead(input.limit, now);
  const scheduled = resume?.status === "scheduled";
  const dispatched = resume?.status === "dispatched";
  const actions = [
    !billing && !dispatched && input.onResumeNow !== undefined ? (
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
  return {
    key: "usage-limit",
    tone: "warning",
    label: "Usage limit",
    text: (
      <UsageLimitStripLine
        limit={input.limit}
        provider={input.provider}
        usageResume={resume}
        now={input.now}
      />
    ),
    ...(actions.length === 0
      ? {}
      : { action: <span className="usage-limit-strip__actions">{actions}</span> }),
  };
}
