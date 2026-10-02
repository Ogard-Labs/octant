import { useEffect, useState, type ReactNode } from "react";
import type { ProviderUsageLimit, UsageResumeThreadState } from "@octant/contracts";
import { resetCountdownLabel } from "../lib/relativeTime";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantAlert } from "../ui/base/OctantAlert";

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
 * The reset line a limit can honestly show. A known absolute time becomes a
 * countdown; an unknown one says so outright rather than fabricating a timer
 * or promising a recovery the provider never announced. Billing stops get no
 * reset line — an account in arrears does not free up on a clock.
 */
export function usageLimitResetLine(limit: ProviderUsageLimit, now: number): string | undefined {
  if (limit.kind === "billing") return undefined;
  if (limit.resetsAt === undefined) {
    return "The provider did not say when this clears.";
  }
  return resetCountdownLabel(limit.resetsAt, now);
}

/**
 * The recovery the notice can offer for this stop. A scheduled resume is the
 * durable opt-in the host will fire at the declared reset; offering it needs
 * a clock to wait on, and a billing stop has no clock it would be honest to
 * wait on.
 */
const canOfferResume = (limit: ProviderUsageLimit): boolean =>
  limit.resetsAt !== undefined && limit.kind !== "billing";

function settledResumeLine(resume: UsageResumeThreadState): string {
  switch (resume.status) {
    case "dispatched":
      return "Resume started.";
    case "invalidated":
      return resume.detail === undefined
        ? "The scheduled resume was invalidated."
        : `The scheduled resume was invalidated: ${resume.detail}`;
    case "failed":
      return resume.detail === undefined
        ? "The scheduled resume could not start."
        : `The scheduled resume could not start: ${resume.detail}`;
    case "scheduled":
      return "";
  }
}

export function UsageLimitNotice(props: {
  readonly limit: ProviderUsageLimit;
  /** "Codex — luna" style label so the sentence names who stopped the turn. */
  readonly provider: string;
  /** The existing manual retry affordance for the mode; no auto-retry. */
  readonly action?: ReactNode;
  /**
   * The thread's durable resume opt-in, when its record names this stop.
   * `resumable` is the caller's word for "this stop is still the thread's
   * latest stopped turn" — the host re-checks the whole premise either way.
   */
  readonly usageResume?: UsageResumeThreadState;
  readonly resumable?: boolean;
  readonly onScheduleResume?: () => void;
  readonly onCancelResume?: () => void;
  /**
   * Hide the thread until this stop's declared reset without authorizing
   * another provider turn. The host derives the wake time from the journaled
   * limit fact; the caller withholds the callback once the thread carries a
   * snooze of its own.
   */
  readonly onSnoozeAtReset?: () => void;
}) {
  const [now, setNow] = useState(() => Date.now());
  // A named reset time becomes a countdown that must keep moving while the
  // notice sits parked; without one the line is static and the tick never
  // needs to run.
  const countdown =
    props.limit.kind !== "billing" && props.limit.resetsAt !== undefined ? true : false;
  useEffect(() => {
    if (!countdown) return;
    const tick = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(tick);
  }, [countdown]);
  const reset = usageLimitResetLine(props.limit, now);
  const resume = props.usageResume;
  // Snoozing shares the resume offer's premise — a current stop that
  // disclosed a real reset — but authorizes nothing: it only shelves the row.
  // A reset already past means the host would refuse the snooze, so the offer
  // hides once its clock runs out rather than inviting a rejected command.
  const snoozeOffer =
    canOfferResume(props.limit) &&
    props.limit.resetsAt !== undefined &&
    new Date(props.limit.resetsAt).getTime() > now &&
    props.resumable === true &&
    props.onSnoozeAtReset !== undefined &&
    // A dispatched recovery just consumed the reset it was waiting on —
    // snoozing until a time that already arrived can only be refused.
    (resume === undefined || resume.status !== "dispatched") ? (
      <p>
        <OctantButton onClick={props.onSnoozeAtReset} size="sm" type="button" variant="secondary">
          Snooze until reset
        </OctantButton>
      </p>
    ) : null;
  return (
    <OctantAlert tone="warning">
      <p>{usageLimitExplanation(props.limit, props.provider)}</p>
      {reset === undefined ? null : <p>{reset}</p>}
      {resume === undefined ? (
        <>
          {canOfferResume(props.limit) &&
          props.resumable === true &&
          props.onScheduleResume !== undefined ? (
            <p>
              <OctantButton
                onClick={props.onScheduleResume}
                size="sm"
                type="button"
                variant="secondary"
              >
                Resume when the limit resets
              </OctantButton>
            </p>
          ) : null}
          {snoozeOffer}
        </>
      ) : resume.status === "scheduled" ? (
        <>
          <p>Resume scheduled — {resetCountdownLabel(resume.record.resetsAt, now)}</p>
          {props.onCancelResume === undefined ? null : (
            <p>
              <OctantButton
                onClick={props.onCancelResume}
                size="sm"
                type="button"
                variant="secondary"
              >
                Cancel resume
              </OctantButton>
            </p>
          )}
          {snoozeOffer}
        </>
      ) : (
        <>
          <p>{settledResumeLine(resume)}</p>
          {resume.status === "dispatched" ||
          !canOfferResume(props.limit) ||
          props.resumable !== true ||
          props.onScheduleResume === undefined ? null : (
            <p>
              <OctantButton
                onClick={props.onScheduleResume}
                size="sm"
                type="button"
                variant="secondary"
              >
                Resume when the limit resets
              </OctantButton>
            </p>
          )}
          {snoozeOffer}
        </>
      )}
      {props.action}
    </OctantAlert>
  );
}
