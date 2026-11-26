import { lazy, Suspense } from "react";
import type { ProviderUsageLimit, UsageResumeThreadState } from "@octant/contracts";
import type { PickerGroup } from "@octant/domain";
import type { ComposerNoticeItem } from "../composer/ComposerNotice";

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

const UsageLimitStripLine = lazy(() =>
  import("./usageLimitStripParts").then(({ UsageLimitStripLine }) => ({
    default: UsageLimitStripLine,
  })),
);
const UsageLimitStripActions = lazy(() =>
  import("./usageLimitStripParts").then(({ UsageLimitStripActions }) => ({
    default: UsageLimitStripActions,
  })),
);

export function usageLimitStripNotice(input: UsageLimitStripInput): ComposerNoticeItem {
  // A billing stop offers nothing at all, so its card carries no action area.
  const offersAnything =
    input.limit.kind !== "billing" &&
    (input.onResumeNow !== undefined ||
      input.onScheduleResume !== undefined ||
      input.onCancelResume !== undefined ||
      input.onSnoozeAtReset !== undefined);
  return {
    key: "usage-limit",
    tone: "warning",
    label: "Usage limit",
    text: (
      <Suspense fallback={null}>
        <UsageLimitStripLine
          limit={input.limit}
          provider={input.provider}
          usageResume={input.usageResume}
          now={input.now}
        />
      </Suspense>
    ),
    ...(offersAnything
      ? {
          action: (
            <Suspense fallback={null}>
              <UsageLimitStripActions input={input} />
            </Suspense>
          ),
        }
      : {}),
  };
}

/**
 * The provider account alone, as the picker names it, for the strip's line.
 * Kept here, with the lazily loaded workspaces that use it, rather than in the
 * shared label module the initial window loads.
 */
export function providerInstanceLabel(
  groups: ReadonlyArray<PickerGroup>,
  providerInstanceId: unknown,
): string {
  return (
    groups.find((candidate) => String(candidate.instance.id) === String(providerInstanceId))
      ?.instance.displayName ?? String(providerInstanceId)
  );
}
