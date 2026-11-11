import { useState } from "react";
import type {
  AutomationDefinition,
  AutomationDefinitionDraft,
  AutomationEventSourceCheckpoint,
} from "@octant/contracts";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantDialog } from "../ui/base/OctantDialog";
import { OctantAlert } from "../ui/base/OctantAlert";
import { automationAuthoritySummary } from "./automationCenterModel";
import type { AutomationCenterController } from "./useAutomationCenterController";

export function AutomationEventSourceStatus(props: {
  readonly automation: AutomationDefinition;
  readonly source: AutomationEventSourceCheckpoint | undefined;
  readonly execute: AutomationCenterController["execute"];
  readonly refresh: () => void;
}) {
  const [review, setReview] = useState<AutomationDefinition>();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string>();
  const [unconfirmed, setUnconfirmed] = useState(false);
  const { automation, source } = props;
  if (automation.trigger.kind !== "integration-event") return null;
  const stale = review !== undefined && review.version !== automation.version;
  async function rearm() {
    if (review === undefined || busy || stale || unconfirmed) return;
    const definition: AutomationDefinitionDraft = {
      displayName: review.displayName,
      taskPrompt: review.taskPrompt,
      hostId: review.hostId,
      mode: review.mode,
      projectId: review.projectId,
      projectVersion: review.projectVersion,
      binding: review.binding,
      executionProfile: review.executionProfile,
      authorityProfile: review.authorityProfile,
      deliveryTarget: review.deliveryTarget,
      trigger: review.trigger,
      missedRunPolicy: review.missedRunPolicy,
      targetPolicy: review.targetPolicy,
      ...(review.projectLevel === undefined ? {} : { projectLevel: review.projectLevel }),
      ...(review.runLevel === undefined ? {} : { runLevel: review.runLevel }),
      ...(review.agentMerge === undefined ? {} : { agentMerge: review.agentMerge }),
    };
    setBusy(true);
    const result = await props.execute(
      {
        kind: "update-automation",
        automationId: review.id,
        expectedVersion: review.version,
        definition,
        rearmEvents: true,
      },
      "Held events skipped. Routine re-armed with a fresh baseline.",
    );
    setBusy(false);
    if (result.kind === "automation-updated") {
      setReview(undefined);
      return;
    }
    setUnconfirmed(true);
    setMessage(
      "Re-arm is unconfirmed. Refresh the routine and its history before another decision.",
    );
  }
  return (
    <section className="automation-detail__facts" aria-label="Event input status">
      <p>
        {automation.trigger.sourceLabel ?? "Integration events"}:{" "}
        {automation.lifecycle === "enabled" ? (source?.phase ?? "arming") : "paused"}.
      </p>
      <p>
        {Math.max(0, automation.trigger.automaticStartLimit - (source?.automaticStarts ?? 0))}{" "}
        automatic runs remaining.
      </p>
      {source?.reason === undefined ? null : (
        <p role="status">
          {source.reason === "busy-input"
            ? "Events arrived during routine activity and need review."
            : source.reason === "activity-history-limit"
              ? "Unsettled routine activity cannot be proven quiet. Finish and review tasks and children, then archive this routine and configure a new one if its retained history is full."
              : source.reason === "routine-output"
                ? "Events may come from routine output and need review."
                : source.reason === "automatic-start-limit"
                  ? "The automatic allowance is used up."
                  : source.reason === "source-limit"
                    ? "The bounded source observation is incomplete. Narrow the source or review and re-arm."
                    : source.reason === "source-changed"
                      ? "The selected source changed. Review its connection and create a new routine for a different account or source."
                      : "The selected source is unavailable. Its cursor and allowance are retained."}
        </p>
      )}
      {source?.coverageGap ? (
        <p>
          The host observed a coverage gap. Only surviving observed events are known; unseen
          intermediate assignments and CI attempts cannot be reconstructed.
        </p>
      ) : null}
      {source?.pending.length ? (
        <ul>
          {source.pending.map((event) => (
            <li key={event.id}>{event.label}</li>
          ))}
        </ul>
      ) : null}
      <OctantButton
        type="button"
        variant="secondary"
        onClick={() => {
          setUnconfirmed(false);
          props.refresh();
        }}
      >
        Refresh event status
      </OctantButton>
      {automation.lifecycle === "enabled" &&
      (source?.phase === "held" || source?.phase === "needs-rearm") ? (
        <OctantButton
          type="button"
          variant="secondary"
          onClick={() => {
            setReview(automation);
            setMessage(undefined);
          }}
        >
          Review and re-arm
        </OctantButton>
      ) : null}
      <OctantDialog
        open={review !== undefined}
        onClose={() => {
          if (!busy) setReview(undefined);
        }}
        label="Review event input"
      >
        <p>{review?.taskPrompt}</p>
        <p>{review?.deliveryTarget.summary}</p>
        {review === undefined ? null : <p>{automationAuthoritySummary(review.authorityProfile)}</p>}
        <p>
          Finish and review existing tasks and their output. Re-arming skips all held events,
          establishes a new baseline and restores the automatic allowance. It starts no task for
          existing events.
        </p>
        {message === undefined && !stale ? null : (
          <OctantAlert tone="warning">
            {message ?? "The routine changed. Close this review and refresh its current state."}
          </OctantAlert>
        )}
        <OctantButton
          type="button"
          variant="outline"
          disabled={busy}
          onClick={() => setReview(undefined)}
        >
          Cancel
        </OctantButton>
        <OctantButton
          type="button"
          disabled={busy || stale || unconfirmed}
          onClick={() => void rearm()}
        >
          Re-arm and skip held events
        </OctantButton>
      </OctantDialog>
    </section>
  );
}
