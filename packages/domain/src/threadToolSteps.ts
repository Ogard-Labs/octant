import {
  MAX_THREAD_TOOL_STEP_SUMMARY_BYTES,
  type ProviderRuntimeEvent,
  type ShieldDecision,
  type ThreadRoutineReceipt,
  type ToolOutsideContentMark,
  type ThreadToolStep,
  type ThreadToolStepList,
} from "@octant/contracts";
import { redactDiagnosticText } from "./diagnosticsPolicy";

/** The tool calls a turn made, and whether it made more than the record keeps. */
export interface ThreadToolSteps {
  readonly steps: ThreadToolStepList;
  readonly truncated: boolean;
}

/**
 * How many tool calls a turn keeps: the person's number for the level the
 * turn runs at. At Full access it is off (`undefined`) until they set one,
 * since the spend ceiling bounds the turn there; `0` is how the setting says
 * off. The caller passes the level the turn runs at, never only the thread's
 * stored level. Chat has no Full access.
 */
export function threadToolStepLimit(input: {
  readonly fullAccess: boolean;
  readonly settings: {
    readonly toolStepsPerTurn: number;
    readonly fullAccessToolStepsPerTurn: number;
  };
}): number | undefined {
  if (!input.fullAccess) return input.settings.toolStepsPerTurn;
  return input.settings.fullAccessToolStepsPerTurn === 0
    ? undefined
    : input.settings.fullAccessToolStepsPerTurn;
}

/** Whether a call with no step yet has no room under the turn's limit. */
function full(steps: ThreadToolStepList, limit: number | undefined): boolean {
  return limit !== undefined && steps.length >= limit;
}

/**
 * The one step that differs between two readings of a turn's steps, so a
 * change is journaled and streamed as that step and never as the whole list:
 * restating the list at every tool event cost bytes that grew with the square
 * of the limit. Every fold here changes at most one step and keeps the others
 * by reference, and the newest calls change most, so this reads from the end.
 * `undefined` when no step changed (the list only became truncated).
 */
export function changedThreadToolStep(
  before: ThreadToolSteps | undefined,
  after: ThreadToolSteps | undefined,
): ThreadToolStep | undefined {
  if (after === undefined || after === before) return undefined;
  for (let index = after.steps.length - 1; index >= 0; index -= 1) {
    const step = after.steps[index];
    if (step !== undefined && step !== before?.steps[index]) return step;
  }
  return undefined;
}

const TRUNCATED_SUFFIX = " [truncated]";
const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** The head of a provider message that fits the record, redacted first; absent when nothing is left. */
function boundedSummary(text: string): string | undefined {
  const trimmed = redactDiagnosticText(text).text.trim();
  if (trimmed === "") return undefined;
  const bytes = encoder.encode(trimmed);
  if (bytes.byteLength <= MAX_THREAD_TOOL_STEP_SUMMARY_BYTES) return trimmed;
  const room = MAX_THREAD_TOOL_STEP_SUMMARY_BYTES - encoder.encode(TRUNCATED_SUFFIX).byteLength;
  // Slicing bytes can cut a multi-byte character; the decoder leaves a
  // replacement character that is wider than the bytes it replaced.
  const head = decoder.decode(bytes.slice(0, room)).replace(/�+$/, "").trimEnd();
  return head === "" ? undefined : `${head}${TRUNCATED_SUFFIX}`;
}

const MAX_IDENTIFIER_BYTES = 255;

/** A provider's tool call id or name cut to what the contract holds; it never fails the turn. */
function boundedIdentifier(text: string): string {
  const trimmed = text.trim();
  const bytes = encoder.encode(trimmed);
  if (bytes.byteLength <= MAX_IDENTIFIER_BYTES) return trimmed;
  return decoder
    .decode(bytes.slice(0, MAX_IDENTIFIER_BYTES))
    .replace(/\uFFFD+$/, "")
    .trimEnd();
}

/**
 * Folds one normalized runtime event into a turn's tool steps, keyed by the
 * provider's own tool call id so a repeated event updates a step instead of
 * adding one. Returns the same value when the event changes nothing, so a
 * caller persists only on a real change. A tool that already ended is never
 * reopened by a late progress message.
 */
export function recordThreadToolStep(
  current: ThreadToolSteps | undefined,
  event: ProviderRuntimeEvent,
  limit: number | undefined,
): ThreadToolSteps | undefined {
  if (
    event.kind !== "tool-start" &&
    event.kind !== "tool-progress" &&
    event.kind !== "tool-success" &&
    event.kind !== "tool-failure"
  ) {
    return current;
  }
  const steps = current?.steps ?? [];
  const toolCallId = boundedIdentifier(event.toolCallId);
  const index = steps.findIndex((step) => step.toolCallId === toolCallId);
  const previous = index === -1 ? undefined : steps[index];
  if (previous === undefined && full(steps, limit)) {
    return current?.truncated === true ? current : { steps, truncated: true };
  }
  const ended = previous?.state === "completed" || previous?.state === "failed";
  let next: ThreadToolStep;
  switch (event.kind) {
    case "tool-start":
      if (previous !== undefined) return current;
      next = { toolCallId, toolName: boundedIdentifier(event.toolName), state: "started" };
      break;
    case "tool-progress": {
      if (ended) return current;
      const summary = boundedSummary(event.message) ?? previous?.summary;
      next = {
        toolCallId,
        toolName: previous?.toolName ?? "Tool",
        state: "running",
        ...(summary === undefined ? {} : { summary }),
        ...(previous?.outsideContent === undefined
          ? {}
          : { outsideContent: previous.outsideContent }),
        ...(previous?.routine === undefined ? {} : { routine: previous.routine }),
      };
      break;
    }
    case "tool-success":
    case "tool-failure": {
      const summary = boundedSummary(event.kind === "tool-success" ? event.summary : event.message);
      const kept = summary ?? previous?.summary;
      const published = event.kind === "tool-success" ? event.published : undefined;
      next = {
        toolCallId,
        toolName: previous?.toolName ?? "Tool",
        state: event.kind === "tool-success" ? "completed" : "failed",
        ...(kept === undefined ? {} : { summary: kept }),
        ...(published === undefined ? {} : { published }),
        ...(previous?.outsideContent === undefined
          ? {}
          : { outsideContent: previous.outsideContent }),
        ...(previous?.routine === undefined ? {} : { routine: previous.routine }),
      };
      break;
    }
  }
  const nextSteps = steps.slice();
  if (index === -1) nextSteps.push(next);
  else nextSteps[index] = next;
  return { steps: nextSteps, truncated: current?.truncated === true };
}

/**
 * Puts the Watcher's mark on one tool call's step, keeping the strongest
 * reading: labels already found stay when a later result adds none. A call
 * with no step yet gets a completed one, so a tool Octant ran for the turn
 * (it announces no start) still has a row to carry the tag. Returns the same
 * value when the mark changes nothing.
 */
export function markThreadToolStepOutsideContent(
  current: ThreadToolSteps | undefined,
  call: {
    readonly toolCallId: string;
    readonly toolName: string;
    readonly mark: ToolOutsideContentMark;
  },
  limit: number | undefined,
): ThreadToolSteps | undefined {
  const steps = current?.steps ?? [];
  const toolCallId = boundedIdentifier(call.toolCallId);
  const index = steps.findIndex((step) => step.toolCallId === toolCallId);
  const previous = index === -1 ? undefined : steps[index];
  if (previous === undefined && full(steps, limit)) {
    return current?.truncated === true ? current : { steps, truncated: true };
  }
  const labels = [...new Set([...(previous?.outsideContent?.labels ?? []), ...call.mark.labels])];
  const sameLabels =
    previous?.outsideContent !== undefined &&
    labels.length === previous.outsideContent.labels.length;
  if (sameLabels) return current;
  const outsideContent: ToolOutsideContentMark = {
    labels,
    ...(call.mark.recordedOnly === true ? { recordedOnly: true } : {}),
  };
  const next: ThreadToolStep =
    previous === undefined
      ? {
          toolCallId,
          toolName: boundedIdentifier(call.toolName),
          state: "completed",
          outsideContent,
        }
      : { ...previous, outsideContent };
  const nextSteps = steps.slice();
  if (index === -1) nextSteps.push(next);
  else nextSteps[index] = next;
  return { steps: nextSteps, truncated: current?.truncated === true };
}

/**
 * Puts the routine a tool call created on that call's step, so the transcript
 * can show what was set up. A call with no step yet gets a completed one, since
 * a tool Octant ran for the turn announces no start. A later progress or
 * success event keeps the receipt. Returns the same value when the step
 * already carries it.
 */
export function markThreadToolStepRoutine(
  current: ThreadToolSteps | undefined,
  call: {
    readonly toolCallId: string;
    readonly toolName: string;
    readonly routine: ThreadRoutineReceipt;
  },
  limit: number | undefined,
): ThreadToolSteps | undefined {
  const steps = current?.steps ?? [];
  const toolCallId = boundedIdentifier(call.toolCallId);
  const index = steps.findIndex((step) => step.toolCallId === toolCallId);
  const previous = index === -1 ? undefined : steps[index];
  if (previous === undefined && full(steps, limit)) {
    return current?.truncated === true ? current : { steps, truncated: true };
  }
  if (previous?.routine?.routineId === call.routine.routineId) return current;
  const next: ThreadToolStep =
    previous === undefined
      ? {
          toolCallId,
          toolName: boundedIdentifier(call.toolName),
          state: "completed",
          routine: call.routine,
        }
      : { ...previous, routine: call.routine };
  const nextSteps = steps.slice();
  if (index === -1) nextSteps.push(next);
  else nextSteps[index] = next;
  return { steps: nextSteps, truncated: current?.truncated === true };
}

/**
 * The row of a tool Octant ran for a turn whose runtime announces no call of
 * its own (an Octant Harness turn): started when the host takes the request,
 * completed or failed when it answers. The step is keyed by the request id
 * the call's record is kept under, so the row opens that record like any
 * other. A tag or a routine the row already carries stays. Returns the same
 * value when nothing changes.
 */
export function recordThreadAppToolStep(
  current: ThreadToolSteps | undefined,
  call: {
    readonly toolCallId: string;
    readonly toolName: string;
    readonly state: "started" | "completed" | "failed";
  },
  limit: number | undefined,
): ThreadToolSteps | undefined {
  const steps = current?.steps ?? [];
  const toolCallId = boundedIdentifier(call.toolCallId);
  const index = steps.findIndex((step) => step.toolCallId === toolCallId);
  const previous = index === -1 ? undefined : steps[index];
  if (previous === undefined && full(steps, limit)) {
    return current?.truncated === true ? current : { steps, truncated: true };
  }
  if (previous?.state === call.state) return current;
  const next: ThreadToolStep =
    previous === undefined
      ? { toolCallId, toolName: boundedIdentifier(call.toolName), state: call.state }
      : { ...previous, state: call.state };
  const nextSteps = steps.slice();
  if (index === -1) nextSteps.push(next);
  else nextSteps[index] = next;
  return { steps: nextSteps, truncated: current?.truncated === true };
}

/**
 * Adds Octant Shield's decision on one approval to a turn's tool steps, as a
 * completed step of its own keyed by the approval's request id. A repeated
 * review of the same request replaces its step. Past the step limit the
 * decision is dropped and the list is marked truncated; the approval journal
 * still holds it.
 */
export function recordThreadShieldReview(
  current: ThreadToolSteps | undefined,
  review: {
    readonly requestId: string;
    readonly toolName: string;
    readonly summary: string;
    readonly decision: ShieldDecision;
  },
  limit: number | undefined,
): ThreadToolSteps {
  const steps = current?.steps ?? [];
  const toolCallId = boundedIdentifier(`shield:${review.requestId}`);
  const summary = boundedSummary(review.summary);
  const next: ThreadToolStep = {
    toolCallId,
    toolName: boundedIdentifier(review.toolName) || "Approval",
    state: "completed",
    ...(summary === undefined ? {} : { summary }),
    shield: review.decision,
  };
  const index = steps.findIndex((step) => step.toolCallId === toolCallId);
  if (index === -1 && full(steps, limit)) {
    return current?.truncated === true ? current : { steps, truncated: true };
  }
  const nextSteps = steps.slice();
  if (index === -1) nextSteps.push(next);
  else nextSteps[index] = next;
  return { steps: nextSteps, truncated: current?.truncated === true };
}
