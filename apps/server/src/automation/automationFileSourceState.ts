import { createHash } from "node:crypto";
import {
  decodeAutomationFileSourceCheckpoint,
  type AutomationFileArrivalReceipt,
  type AutomationFileArrivalTrigger,
  type AutomationFileSourceCheckpoint,
  type AutomationSourceSnapshot,
  type UtcTimestamp,
} from "@octant/contracts";

export function automationSourceSnapshotDigest(snapshot: AutomationSourceSnapshot): string {
  return createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");
}

export function validateAutomationFileCheckpoint(checkpoint: AutomationFileSourceCheckpoint): void {
  if (
    checkpoint.baselineDigest !== automationSourceSnapshotDigest(checkpoint.baseline) ||
    (checkpoint.held !== undefined &&
      checkpoint.held.digest !== automationSourceSnapshotDigest(checkpoint.held.snapshot))
  ) {
    throw new Error("File source content digest does not match its complete observation.");
  }
}

export function initialAutomationFileCheckpoint(
  sourceIdentity: string,
  at: UtcTimestamp,
): AutomationFileSourceCheckpoint {
  return decodeAutomationFileSourceCheckpoint({
    sourceIdentity,
    observationRevision: 1,
    armGeneration: 1,
    automaticStarts: 0,
    baselineReady: false,
    baseline: [],
    baselineDigest: automationSourceSnapshotDigest([]),
    observedAt: at,
    phase: "arming",
    coverageGap: false,
    activityWindow: [],
    busyChangeObserved: false,
  });
}

export function changedAutomationSourceFiles(
  before: AutomationSourceSnapshot,
  after: AutomationSourceSnapshot,
): ReadonlyArray<string> {
  const previous = new Map(before.map((file) => [file.path, file.digest]));
  return after.filter((file) => previous.get(file.path) !== file.digest).map((file) => file.path);
}

export type AutomationFileObservationDecision =
  | { readonly kind: "unchanged" }
  | { readonly kind: "checkpoint"; readonly checkpoint: AutomationFileSourceCheckpoint }
  | { readonly kind: "claim"; readonly receipt: AutomationFileArrivalReceipt };

/** A scan is evidence of final content, never evidence of who wrote it. */
export function reconcileAutomationFileObservation(input: {
  readonly trigger: AutomationFileArrivalTrigger;
  readonly previous: AutomationFileSourceCheckpoint;
  readonly snapshot: AutomationSourceSnapshot;
  readonly observedAt: UtcTimestamp;
  readonly settled: boolean;
  readonly activity: "busy" | "quiet" | "unknown";
  readonly coverageGap: boolean;
  readonly missedRunPolicy: "skip" | "run-once";
}): AutomationFileObservationDecision {
  const { previous, snapshot } = input;
  const digest = automationSourceSnapshotDigest(snapshot);
  const changed = digest !== previous.baselineDigest;
  const files = changedAutomationSourceFiles(previous.baseline, snapshot);
  const next = (
    updates: Partial<AutomationFileSourceCheckpoint>,
    clearTransient = false,
  ): AutomationFileSourceCheckpoint => {
    const { reason: _reason, held: _held, ...clean } = previous;
    return decodeAutomationFileSourceCheckpoint({
      ...(clearTransient ? clean : previous),
      ...updates,
      observationRevision: previous.observationRevision + 1,
      observedAt: input.observedAt,
      coverageGap: previous.coverageGap || input.coverageGap,
    });
  };
  const checkpoint = (
    updates: Partial<AutomationFileSourceCheckpoint>,
  ): AutomationFileObservationDecision => ({ kind: "checkpoint", checkpoint: next(updates) });
  const held = { files, snapshot, digest, observedAt: input.observedAt };

  // A changed definition/root requires explicit review, regardless of later quiet scans.
  if (
    previous.reason === "activity-history-limit" ||
    previous.reason === "source-changed" ||
    previous.reason === "authority-changed"
  )
    return { kind: "unchanged" };
  if (input.activity !== "quiet") {
    const activityReason =
      previous.reason === "definition-changed"
        ? "definition-changed"
        : input.activity === "unknown"
          ? "activity-unknown"
          : "known-activity";
    if (
      previous.reason === activityReason &&
      previous.busyChangeObserved === (previous.busyChangeObserved || changed) &&
      (!changed || previous.held?.digest === digest)
    )
      return { kind: "unchanged" };
    return checkpoint({
      phase: previous.baselineReady ? "needs-rearm" : "arming",
      reason: activityReason,
      busyChangeObserved: previous.busyChangeObserved || (previous.baselineReady && changed),
      ...(previous.baselineReady && changed ? { held } : {}),
    });
  }
  if (!input.settled) return { kind: "unchanged" };
  if (!previous.baselineReady) {
    const { reason: _reason, held: _held, ...clean } = previous;
    return {
      kind: "checkpoint",
      checkpoint: next(
        {
          ...clean,
          baselineReady: true,
          baseline: snapshot,
          baselineDigest: digest,
          phase: "watching",
          activityWindow: [],
          busyChangeObserved: false,
        },
        true,
      ),
    };
  }
  if (previous.reason === "definition-changed") {
    if (
      previous.phase === "held" &&
      previous.held?.digest === digest &&
      previous.activityWindow.length === 0
    )
      return { kind: "unchanged" };
    return checkpoint({ phase: "held", reason: "definition-changed", activityWindow: [], held });
  }
  if (
    previous.busyChangeObserved ||
    previous.phase === "held" ||
    (previous.activityWindow.length !== 0 && changed)
  ) {
    if (
      previous.phase === "held" &&
      previous.held?.digest === digest &&
      previous.activityWindow.length === 0
    )
      return { kind: "unchanged" };
    return checkpoint({
      phase: "held",
      reason:
        previous.automaticStarts >= input.trigger.automaticStartLimit
          ? "automatic-start-limit"
          : "input-changed-while-running",
      busyChangeObserved: true,
      activityWindow: [],
      held,
    });
  }
  if (previous.automaticStarts >= input.trigger.automaticStartLimit) {
    if (
      previous.reason === "automatic-start-limit" &&
      (!changed || previous.held?.digest === digest)
    )
      return { kind: "unchanged" };
    return checkpoint({
      phase: changed ? "held" : "needs-rearm",
      reason: "automatic-start-limit",
      activityWindow: [],
      ...(changed ? { held } : {}),
    });
  }
  // Only a known current quiescent observation closes the retained activity window.
  const { reason: _reason, held: _held, ...clean } = previous;
  const base = {
    ...clean,
    phase: "watching" as const,
    baseline: snapshot,
    baselineDigest: digest,
    activityWindow: [],
    busyChangeObserved: false,
    coverageGap: previous.coverageGap || input.coverageGap,
  };
  if (!changed) {
    return previous.activityWindow.length !== 0 ||
      previous.phase !== "watching" ||
      previous.reason !== undefined ||
      (input.coverageGap && !previous.coverageGap)
      ? { kind: "checkpoint", checkpoint: next(base, true) }
      : { kind: "unchanged" };
  }
  if (files.length === 0 || (input.coverageGap && input.missedRunPolicy === "skip"))
    return { kind: "checkpoint", checkpoint: next(base, true) };
  const count = previous.automaticStarts + 1;
  const claimed = next(
    {
      ...base,
      automaticStarts: count,
      ...(count === input.trigger.automaticStartLimit
        ? { phase: "needs-rearm", reason: "automatic-start-limit" }
        : {}),
    },
    true,
  );
  return { kind: "claim", receipt: { checkpoint: claimed, files, automaticStartOrdinal: count } };
}
