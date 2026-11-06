import { Schema } from "effect";
import {
  AutomationEventSourceCheckpoint,
  type AutomationIntegrationEvent,
  type AutomationEventSourceWindow,
  type AutomationIntegrationEventReceipt,
  type AutomationIntegrationEventTrigger,
  type UtcTimestamp,
} from "@octant/contracts";

const decode = Schema.decodeUnknownSync(AutomationEventSourceCheckpoint);
export function initialAutomationEventCheckpoint(
  identity: string,
  at: UtcTimestamp,
): AutomationEventSourceCheckpoint {
  return decode({
    sourceIdentity: identity,
    observationRevision: 0,
    automaticStarts: 0,
    baselineReady: false,
    seen: [],
    pending: [],
    observedAt: at,
    phase: "arming",
    coverageGap: false,
  });
}
export type AutomationEventObservation =
  | { readonly kind: "checkpoint"; readonly checkpoint: AutomationEventSourceCheckpoint }
  | { readonly kind: "claim"; readonly receipt: AutomationIntegrationEventReceipt };

/** A complete bounded observation describes surviving events, never unseen history or its author. */
export function reconcileAutomationEventObservation(input: {
  readonly previous: AutomationEventSourceCheckpoint;
  readonly trigger: AutomationIntegrationEventTrigger;
  readonly events: ReadonlyArray<AutomationIntegrationEvent>;
  readonly window?: AutomationEventSourceWindow;
  readonly semantics: "assignment-set" | "append";
  readonly observedAt: UtcTimestamp;
  readonly coverageGap: boolean;
  readonly missedRunPolicy: "skip" | "run-once";
  readonly busy: boolean;
}): AutomationEventObservation {
  const { previous } = input;
  const next = (updates: Partial<AutomationEventSourceCheckpoint>) => {
    const { reason: _reason, ...clean } = previous;
    return decode({
      ...(updates.phase === "watching" ? clean : previous),
      ...updates,
      observationRevision: previous.observationRevision + 1,
      observedAt: input.observedAt,
      ...(input.window === undefined ? {} : { observedWindow: input.window.ids }),
      coverageGap: previous.coverageGap || input.coverageGap,
    });
  };
  const checkpoint = (
    updates: Partial<AutomationEventSourceCheckpoint>,
  ): AutomationEventObservation => ({ kind: "checkpoint", checkpoint: next(updates) });
  if (previous.phase === "held" || previous.phase === "needs-rearm") return checkpoint({});
  if (
    input.events.length > 256 ||
    new Set(input.events.map((event) => event.id)).size !== input.events.length
  )
    return checkpoint({ phase: "needs-rearm", reason: "source-limit" });
  const seenBefore = new Set(previous.seen);
  const fresh = input.events.filter((event) => !seenBefore.has(event.id));
  const windowIds = input.window?.ids ?? input.events.map((event) => event.id);
  const previousWindow = new Set(previous.observedWindow ?? previous.seen);
  const currentWindow = new Set(windowIds);
  if (input.window !== undefined && input.events.some((event) => !currentWindow.has(event.id)))
    return checkpoint({ phase: "needs-rearm", reason: "source-limit" });
  if (
    input.semantics === "append" &&
    previous.baselineReady &&
    (input.window?.atLimit ?? input.events.length >= 100) &&
    windowIds.length > 0 &&
    windowIds.every((id) => !previousWindow.has(id))
  )
    return checkpoint({ phase: "needs-rearm", reason: "source-limit" });
  const seen =
    input.semantics === "assignment-set"
      ? input.events.map((event) => event.id)
      : [...new Set([...previous.seen, ...input.events.map((event) => event.id)])];
  if (seen.length > 256) return checkpoint({ phase: "needs-rearm", reason: "source-limit" });
  if (!previous.baselineReady) return checkpoint({ baselineReady: true, seen, phase: "watching" });
  const pending = [...previous.pending, ...fresh].sort(
    (a, b) => a.occurredAt.localeCompare(b.occurredAt) || a.id.localeCompare(b.id),
  );
  if (pending.length > 32) return checkpoint({ phase: "needs-rearm", reason: "source-limit" });
  if (pending.some((event) => event.routineOutput))
    return checkpoint({ seen, pending, phase: "held", reason: "routine-output" });
  if (input.busy && fresh.length > 0)
    return checkpoint({ seen, pending, phase: "held", reason: "busy-input" });
  if (input.coverageGap) {
    if (input.missedRunPolicy === "skip")
      return checkpoint({ seen, pending: [], phase: "watching" });
    pending.splice(0, Math.max(0, pending.length - 1));
  }
  if (previous.automaticStarts >= input.trigger.automaticStartLimit)
    return checkpoint({ seen, pending, phase: "needs-rearm", reason: "automatic-start-limit" });
  const event = input.busy ? undefined : pending.shift();
  if (event === undefined) return checkpoint({ seen, pending, phase: "watching" });
  return {
    kind: "claim",
    receipt: {
      event,
      checkpoint: next({
        seen,
        pending,
        phase: "watching",
        automaticStarts: previous.automaticStarts + 1,
      }),
    },
  };
}
