import { useState, type ReactNode } from "react";
import type { ProviderUsageLimit, UsageResumeThreadState } from "@octant/contracts";
import { resetClock } from "./resetClock";
import { OctantAlert } from "../ui/base/OctantAlert";
import "./usage-limit-record.css";

/**
 * What the person is told when a provider's own protocol signal stopped a
 * turn on a usage limit. The copy is keyed on the normalized kind, never on
 * the provider's free-text message — a provider-reported fact chooses one of
 * three honest sentences, and nothing else can grow a countdown.
 */
export function usageLimitExplanation(limit: ProviderUsageLimit, provider: string): string {
  switch (limit.kind) {
    case "temporary":
      return `${provider} reached a temporary rate limit.`;
    case "exhausted":
      return `${provider}'s usage allowance on this account is exhausted.`;
    case "billing":
      return `${provider} reports a billing or credit problem on this account.`;
  }
}

/**
 * The reset sentence a limit can honestly show. A known time is named as a
 * clock time, since the record stays in the transcript long after a countdown
 * would have gone stale; an unknown one says so outright rather than
 * promising a recovery the provider never announced. Billing stops get no
 * reset sentence — an account in arrears does not free up on a clock.
 */
export function usageLimitResetLine(limit: ProviderUsageLimit, now: number): string | undefined {
  if (limit.kind === "billing") return undefined;
  if (limit.resetsAt === undefined) {
    return "The provider did not say when this clears.";
  }
  return `It resets at ${resetClock(limit.resetsAt, now)}.`;
}

/**
 * The transcript's record of a limit stop: one quiet line with the provider's
 * own sentence and its reset, never the recovery offers. Those sit in the
 * strip above the composer while the stop is current
 * (`usageLimitStripNotice`), so a thread with several stops reads one line per
 * stop instead of a stack of tall alerts.
 */
export function UsageLimitNotice(props: {
  readonly limit: ProviderUsageLimit;
  /** "Codex — luna" style label so the sentence names who stopped the turn. */
  readonly provider: string;
  /** The existing manual retry affordance for the mode; no auto-retry. */
  readonly action?: ReactNode;
  /** The thread's resume record, when it names this stop: a dispatched one is told here. */
  readonly usageResume?: UsageResumeThreadState;
}) {
  const [now] = useState(() => Date.now());
  const reset = usageLimitResetLine(props.limit, now);
  const resumed = props.usageResume?.status === "dispatched";
  return (
    <OctantAlert
      {...(props.action === undefined ? {} : { action: props.action })}
      className="usage-limit-record"
      layout="row"
      role="status"
      testId="usage-limit-record"
      tone="warning"
    >
      <p>
        {usageLimitExplanation(props.limit, props.provider)}
        {reset === undefined || resumed ? null : ` ${reset}`}
        {resumed ? " Resumed at the reset." : null}
      </p>
    </OctantAlert>
  );
}
