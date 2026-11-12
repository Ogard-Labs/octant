import type { AutomationDefinition, AutomationFileSourceSummary } from "@octant/contracts";
import { useEffect, useId, useRef, useState } from "react";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantDialog } from "../ui/base/OctantDialog";
import { OctantDialogPresence } from "../ui/base/OctantDialogPresence";
import type { AutomationCenterController } from "./useAutomationCenterController";
import { AUTOMATION_RUN_LEVEL_OPTIONS, automationAuthoritySummary } from "./automationCenterModel";
import { routineFileSourceLabel } from "./routineFileSourcePresentation";

export function AutomationFileSourceStatus(props: {
  readonly automation: AutomationDefinition;
  readonly source: AutomationFileSourceSummary | undefined;
  readonly execute: AutomationCenterController["execute"];
  readonly refresh: () => void;
}) {
  const [review, setReview] = useState<
    | { readonly automation: AutomationDefinition; readonly source: AutomationFileSourceSummary }
    | undefined
  >();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | undefined>();
  const [requiresRefresh, setRequiresRefresh] = useState(false);
  const epoch = useRef(0);
  const closeRef = useRef<HTMLButtonElement>(null);
  const reviewRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  useEffect(
    () => () => {
      epoch.current += 1;
    },
    [],
  );
  const { automation, source } = props;
  if (automation.trigger.kind !== "file-arrival") return null;
  const canReview =
    automation.lifecycle !== "archived" &&
    source !== undefined &&
    (source.phase === "held" ||
      (source.phase === "needs-rearm" && source.reason === "automatic-start-limit")) &&
    source.sourceIdentity !== undefined &&
    source.reviewDigest !== undefined;
  const stale =
    review !== undefined &&
    (review.automation.id !== automation.id ||
      review.automation.version !== automation.version ||
      review.source.observationRevision !== source?.observationRevision ||
      review.source.reviewDigest !== source?.reviewDigest ||
      review.source.sourceIdentity !== source?.sourceIdentity);
  const close = () => {
    epoch.current += 1;
    setReview(undefined);
    setBusy(false);
    setMessage(undefined);
  };
  async function rearm(disposition: "skip" | "run-once") {
    if (
      busy ||
      stale ||
      requiresRefresh ||
      review === undefined ||
      review.source.sourceIdentity === undefined ||
      review.source.reviewDigest === undefined
    )
      return;
    const current = ++epoch.current;
    setBusy(true);
    setMessage(undefined);
    const outcome = await props.execute(
      {
        kind: "rearm-file-automation",
        automationId: review.automation.id,
        expectedVersion: review.automation.version,
        sourceIdentity: review.source.sourceIdentity,
        observationRevision: review.source.observationRevision,
        batchDigest: review.source.reviewDigest,
        disposition,
      },
      disposition === "skip"
        ? "Input skipped and routine re-armed."
        : "Reviewed input admitted once; routine re-armed.",
    );
    if (current !== epoch.current) return;
    setBusy(false);
    if (outcome.kind === "automation-resumed" || outcome.kind === "automation-run-accepted") {
      close();
      return;
    }
    const failure =
      outcome.kind === "automation-command-failed" || outcome.kind === "automation-transport-failed"
        ? outcome.message
        : "The input could not be re-armed. Refresh its details and try again.";
    setMessage(failure);
    setRequiresRefresh(
      outcome.kind === "automation-transport-failed" ||
        (outcome.kind === "automation-command-failed" && outcome.reason === "stale-version"),
    );
  }
  return (
    <section aria-label="File input" className="automation-editor__field automation-file-source">
      <h4>File input</h4>
      <p role="status">
        {automation.lifecycle === "archived" ? "Archived" : routineFileSourceLabel(source)} ·{" "}
        {source?.remainingStarts ?? automation.trigger.automaticStartLimit} automatic starts
        remaining
      </p>
      <p>
        Input folder: <code>{automation.trigger.directory}</code>
      </p>
      {source?.reason === "activity-history-limit" ? (
        <p>
          This routine exceeded its bounded unsettled activity history. Review and finish its
          Project tasks and cleanup, then archive it and create a new file routine; this source
          cannot establish quiescence.
        </p>
      ) : null}
      {source?.reason === "source-limit" ? (
        <p>
          Choose a smaller folder or narrower filters: at most 4,096 entries, 256 matching files, 16
          MiB per file and 64 MiB total can be observed.
        </p>
      ) : null}
      {source?.reason === "source-changed" || source?.reason === "authority-changed" ? (
        <p>
          The input folder or its Project authority changed. Edit and save this setup before
          reviewing current input.
        </p>
      ) : null}
      {source?.reason === "known-activity" || source?.reason === "activity-unknown" ? (
        <p>
          Finish or stop known Project work and its cleanup, then check this input again; first-turn
          completion alone does not prove it is quiet.
        </p>
      ) : null}
      {source?.coverageGap ? (
        <p>
          Observation had a coverage gap; only net changed files that still exist can be recovered.
        </p>
      ) : null}
      <p>
        Any matching change through a busy activity window is held for review. Existing files are
        ignored on the first baseline; hidden, linked, excluded and protected entries stay out of
        the input.
      </p>
      {source?.phase === "held" ? (
        <p>Run now is a separate manual task; it does not clear or re-arm this held input.</p>
      ) : null}
      <div className="automation-detail__actions">
        <OctantButton type="button" variant="secondary" onClick={props.refresh}>
          Check input status
        </OctantButton>
        {canReview && source !== undefined ? (
          <OctantButton
            ref={reviewRef}
            type="button"
            variant="secondary"
            onClick={() => {
              setMessage(
                requiresRefresh
                  ? "Refresh details and run history before choosing again; the previous review is unconfirmed."
                  : undefined,
              );
              setReview({ automation, source });
            }}
          >
            Review and re-arm
          </OctantButton>
        ) : null}
      </div>
      <OctantDialogPresence>
        {review !== undefined ? (
          <OctantDialog
            open
            onClose={close}
            label="Review file input"
            labelledBy={titleId}
            initialFocus={closeRef}
            restoreFocus={reviewRef}
            className="automation-editor automation-file-source"
          >
            <h3 id={titleId}>Review file input</h3>
            <p>
              {review?.automation.displayName}:{" "}
              <code>
                {review?.automation.trigger.kind === "file-arrival"
                  ? review.automation.trigger.directory
                  : ""}
              </code>
            </p>
            <p>
              These changes may be outside arrivals or routine output; Octant cannot identify their
              writer.
            </p>
            {review === undefined ? null : (
              <dl className="automation-detail__facts">
                <div>
                  <dt>Task</dt>
                  <dd>{review.automation.taskPrompt}</dd>
                </div>
                <div>
                  <dt>Profile and authority</dt>
                  <dd>
                    {review.automation.executionProfile.modelId} ·{" "}
                    {automationAuthoritySummary(review.automation.authorityProfile)}
                  </dd>
                </div>
                <div>
                  <dt>Level ceiling</dt>
                  <dd>
                    {
                      AUTOMATION_RUN_LEVEL_OPTIONS.find(
                        (option) =>
                          option.id ===
                          (review.automation.projectLevel === "opted-in"
                            ? "project"
                            : (review.automation.runLevel ??
                              (review.automation.authorityProfile.effective.executionPolicy ===
                              "auto-accept-edits"
                                ? "auto-accept-edits"
                                : "ask-first"))),
                      )?.label
                    }
                    ; the Project's current grant can narrow it.
                  </dd>
                </div>
                <div>
                  <dt>Confirmed delivery</dt>
                  <dd>{review.automation.deliveryTarget.summary}</dd>
                </div>
              </dl>
            )}
            <p>
              Run once starts one new Work task with the current profile, level and confirmed
              delivery. Skip records these files as the new baseline without a run. Either starts a
              new allowance of {automation.trigger.automaticStartLimit} automatic runs.
            </p>
            <p>{review?.source.heldFiles.length ?? 0} changed surviving files in this review:</p>
            <ul>
              {review?.source.heldFiles.slice(0, 12).map((path) => (
                <li key={path}>
                  <code>{path}</code>
                </li>
              ))}
            </ul>
            {(review?.source.heldFiles.length ?? 0) > 12 ? (
              <p>
                {(review?.source.heldFiles.length ?? 0) - 12} more files are retained in the batch.
              </p>
            ) : null}
            {review?.source.heldFiles.length === 0 ? (
              <p>No changed surviving files remain; choose Skip to re-arm without a run.</p>
            ) : null}
            {stale ? (
              <p role="alert">
                This input review changed. Check input status and review the current batch before
                choosing.
              </p>
            ) : null}
            {message === undefined ? null : <p role="alert">{message}</p>}
            {busy ? (
              <p role="status">
                Checking and committing your choice. Closing this review does not undo an admitted
                task.
              </p>
            ) : null}
            <div className="automation-detail__actions">
              <OctantButton ref={closeRef} type="button" variant="outline" onClick={close}>
                Close review
              </OctantButton>
              {requiresRefresh || stale ? (
                <OctantButton type="button" onClick={props.refresh}>
                  Refresh details and history
                </OctantButton>
              ) : (
                <>
                  <OctantButton
                    type="button"
                    variant="secondary"
                    disabled={busy || review === undefined}
                    onClick={() => {
                      void rearm("skip");
                    }}
                  >
                    Skip these changes and re-arm
                  </OctantButton>
                  <OctantButton
                    type="button"
                    disabled={busy || review === undefined || review.source.heldFiles.length === 0}
                    onClick={() => {
                      void rearm("run-once");
                    }}
                  >
                    Run once and re-arm
                  </OctantButton>
                </>
              )}
            </div>
          </OctantDialog>
        ) : null}
      </OctantDialogPresence>
    </section>
  );
}
