import {
  MAX_THREAD_TOOL_STEP_SUMMARY_BYTES,
  MAX_THREAD_TOOL_STEPS_PER_TURN,
  type ProviderRuntimeEvent,
  type ThreadToolStep,
  type ThreadToolStepList,
} from "@octant/contracts";
import { redactDiagnosticText } from "./diagnosticsPolicy";

/** The tool calls a turn made, and whether it made more than the record keeps. */
export interface ThreadToolSteps {
  readonly steps: ThreadToolStepList;
  readonly truncated: boolean;
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
  const index = steps.findIndex((step) => step.toolCallId === event.toolCallId);
  const previous = index === -1 ? undefined : steps[index];
  if (previous === undefined && steps.length >= MAX_THREAD_TOOL_STEPS_PER_TURN) {
    return current?.truncated === true ? current : { steps, truncated: true };
  }
  const ended = previous?.state === "completed" || previous?.state === "failed";
  let next: ThreadToolStep;
  switch (event.kind) {
    case "tool-start":
      if (previous !== undefined) return current;
      next = { toolCallId: event.toolCallId, toolName: event.toolName, state: "started" };
      break;
    case "tool-progress": {
      if (ended) return current;
      const summary = boundedSummary(event.message) ?? previous?.summary;
      next = {
        toolCallId: event.toolCallId,
        toolName: previous?.toolName ?? "Tool",
        state: "running",
        ...(summary === undefined ? {} : { summary }),
      };
      break;
    }
    case "tool-success":
    case "tool-failure": {
      const summary = boundedSummary(event.kind === "tool-success" ? event.summary : event.message);
      const kept = summary ?? previous?.summary;
      next = {
        toolCallId: event.toolCallId,
        toolName: previous?.toolName ?? "Tool",
        state: event.kind === "tool-success" ? "completed" : "failed",
        ...(kept === undefined ? {} : { summary: kept }),
      };
      break;
    }
  }
  const nextSteps = steps.slice();
  if (index === -1) nextSteps.push(next);
  else nextSteps[index] = next;
  return { steps: nextSteps, truncated: current?.truncated === true };
}
