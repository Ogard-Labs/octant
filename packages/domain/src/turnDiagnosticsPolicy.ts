import {
  MAX_TURN_DIAGNOSTIC_TOOLS,
  MAX_TURN_FAILURE_MESSAGE_LENGTH,
  type ProviderFailure,
  type ProviderOutputStopReason,
  type ProviderRuntimeEvent,
  type TurnDiagnostics,
  type TurnFailureFacts,
  type TurnRetryTally,
  type TurnToolTally,
} from "@octant/contracts";
import { redactDiagnosticText } from "./diagnosticsPolicy";

/**
 * What went wrong inside a turn, counted from the normalized runtime events
 * every provider produces, beside the turn's timing. No driver counts
 * anything itself, so a tool failure on Codex and one on Octant Harness land
 * in the same tally.
 *
 * Only closed values and numbers are kept. A tool's failure text is the tool's
 * output and stays in the transcript; the provider's own failure line is the
 * one piece of text, redacted and cut before it is kept.
 */

interface ToolCounts {
  readonly calls: number;
  readonly failed: number;
  readonly finished: number;
  readonly nonZeroExits: number;
  readonly totalMs: number;
  readonly maxMs: number;
}

interface OpenToolCall {
  readonly toolName: string;
  readonly startedAtMs: number | undefined;
}

type RetryReason = TurnRetryTally["reason"];

export interface TurnDiagnosticsState {
  readonly tools: Readonly<Record<string, ToolCounts>>;
  readonly openCalls: Readonly<Record<string, OpenToolCall>>;
  /** Results for calls whose start the provider never streamed. */
  readonly unattributedCalls: number;
  readonly unattributedFailures: number;
  readonly retries: Readonly<Partial<Record<RetryReason, { count: number; waitMs: number }>>>;
  readonly approvalRequests: number;
  readonly inputRequests: number;
  readonly rateLimitWarnings: number;
  readonly rateLimitExhausted: boolean;
  readonly compactions: number;
  readonly outputStopReason: ProviderOutputStopReason | undefined;
  readonly failure: TurnFailureFacts | undefined;
}

/** Longest tool name kept; a longer one is cut rather than dropped. */
const MAX_TOOL_NAME_LENGTH = 128;

export function startTurnDiagnostics(): TurnDiagnosticsState {
  return {
    tools: {},
    openCalls: {},
    unattributedCalls: 0,
    unattributedFailures: 0,
    retries: {},
    approvalRequests: 0,
    inputRequests: 0,
    rateLimitWarnings: 0,
    rateLimitExhausted: false,
    compactions: 0,
    outputStopReason: undefined,
    failure: undefined,
  };
}

const EMPTY_COUNTS: ToolCounts = {
  calls: 0,
  failed: 0,
  finished: 0,
  nonZeroExits: 0,
  totalMs: 0,
  maxMs: 0,
};

export function observeTurnDiagnostics(
  state: TurnDiagnosticsState,
  event: ProviderRuntimeEvent,
): TurnDiagnosticsState {
  const parsed = Date.parse(event.occurredAt);
  const at = Number.isFinite(parsed) ? parsed : undefined;
  switch (event.kind) {
    case "tool-start": {
      // A provider that restates a start for a call already open is not a second call.
      if (state.openCalls[event.toolCallId] !== undefined) return state;
      const toolName = boundedToolName(event.toolName);
      const counts = state.tools[toolName] ?? EMPTY_COUNTS;
      return {
        ...state,
        tools: { ...state.tools, [toolName]: { ...counts, calls: counts.calls + 1 } },
        openCalls: { ...state.openCalls, [event.toolCallId]: { toolName, startedAtMs: at } },
      };
    }
    case "tool-success":
    case "tool-failure":
      return observeToolResult(state, event, at);
    case "retrying": {
      const current = state.retries[event.reason] ?? { count: 0, waitMs: 0 };
      return {
        ...state,
        retries: {
          ...state.retries,
          [event.reason]: { count: current.count + 1, waitMs: current.waitMs + event.delayMs },
        },
      };
    }
    case "approval-request":
      return { ...state, approvalRequests: state.approvalRequests + 1 };
    case "user-input-request":
      return { ...state, inputRequests: state.inputRequests + 1 };
    case "rate-limit-window":
      return event.status === "allowed"
        ? state
        : {
            ...state,
            rateLimitWarnings: state.rateLimitWarnings + 1,
            rateLimitExhausted: state.rateLimitExhausted || event.status === "exhausted",
          };
    case "rate-limit-bucket":
      return event.remaining > 0
        ? state
        : { ...state, rateLimitWarnings: state.rateLimitWarnings + 1, rateLimitExhausted: true };
    case "context-compacted":
      return { ...state, compactions: state.compactions + 1 };
    case "completed":
      return event.stopReason === undefined
        ? state
        : { ...state, outputStopReason: event.stopReason };
    case "failed":
      // Counting never decides how a turn ends, so a failure event that
      // arrives without its structure (a scripted or partly built event) is
      // left uncounted rather than thrown on.
      return typeof event.failure?.category === "string"
        ? { ...state, failure: failureFacts(event.failure) }
        : state;
    default:
      return state;
  }
}

function observeToolResult(
  state: TurnDiagnosticsState,
  event: Extract<ProviderRuntimeEvent, { kind: "tool-success" | "tool-failure" }>,
  at: number | undefined,
): TurnDiagnosticsState {
  const failed = event.kind === "tool-failure" ? 1 : 0;
  const open = state.openCalls[event.toolCallId];
  if (open === undefined) {
    return {
      ...state,
      unattributedCalls: state.unattributedCalls + 1,
      unattributedFailures: state.unattributedFailures + failed,
    };
  }
  const { [event.toolCallId]: _closed, ...stillOpen } = state.openCalls;
  const counts = state.tools[open.toolName] ?? EMPTY_COUNTS;
  const durationMs =
    at !== undefined && open.startedAtMs !== undefined
      ? Math.max(0, Math.round(at - open.startedAtMs))
      : 0;
  const nonZeroExit = event.exitCode !== undefined && event.exitCode !== 0 ? 1 : 0;
  return {
    ...state,
    openCalls: stillOpen,
    tools: {
      ...state.tools,
      [open.toolName]: {
        calls: counts.calls,
        failed: counts.failed + failed,
        finished: counts.finished + 1,
        nonZeroExits: counts.nonZeroExits + nonZeroExit,
        totalMs: counts.totalMs + durationMs,
        maxMs: Math.max(counts.maxMs, durationMs),
      },
    },
  };
}

function boundedToolName(name: string): string {
  const trimmed = name.trim();
  return trimmed.length > MAX_TOOL_NAME_LENGTH
    ? trimmed.slice(0, MAX_TOOL_NAME_LENGTH).trimEnd()
    : trimmed;
}

/**
 * The structured part of a provider failure, kept whole, and its message
 * redacted, folded onto one line, and cut. A message that redacts to nothing
 * is left out rather than kept empty.
 */
export function failureFacts(failure: ProviderFailure): TurnFailureFacts {
  const message = boundedFailureMessage(failure.message);
  const process = failure.diagnostic;
  return {
    category: failure.category,
    ...(failure.reason === undefined ? {} : { reason: failure.reason }),
    ...(process === undefined
      ? {}
      : {
          process: {
            stage: process.stage,
            kind: process.kind,
            ...(process.exitCode === undefined ? {} : { exitCode: process.exitCode }),
            ...(process.signal === undefined ? {} : { signal: process.signal }),
          },
        }),
    ...(failure.usageLimit === undefined ? {} : { usageLimit: failure.usageLimit.kind }),
    ...(failure.retryAfterMs === undefined ? {} : { retryAfterMs: failure.retryAfterMs }),
    ...(message === undefined ? {} : { message }),
  };
}

function boundedFailureMessage(raw: string | undefined): string | undefined {
  if (typeof raw !== "string") return undefined;
  const oneLine = redactDiagnosticText(raw).text.replace(/\s+/g, " ").trim();
  if (oneLine.length === 0) return undefined;
  return oneLine.length > MAX_TURN_FAILURE_MESSAGE_LENGTH
    ? `${oneLine.slice(0, MAX_TURN_FAILURE_MESSAGE_LENGTH - 1).trimEnd()}…`
    : oneLine;
}

export function finishTurnDiagnostics(state: TurnDiagnosticsState): TurnDiagnostics {
  const unfinishedByTool = new Map<string, number>();
  for (const open of Object.values(state.openCalls)) {
    unfinishedByTool.set(open.toolName, (unfinishedByTool.get(open.toolName) ?? 0) + 1);
  }
  const tallies: TurnToolTally[] = Object.entries(state.tools).map(([toolName, counts]) => ({
    toolName,
    calls: counts.calls,
    failed: counts.failed,
    unfinished: unfinishedByTool.get(toolName) ?? 0,
    ...(counts.nonZeroExits > 0 ? { nonZeroExits: counts.nonZeroExits } : {}),
    totalMs: counts.totalMs,
    maxMs: counts.maxMs,
  }));
  tallies.sort(
    (left, right) => right.calls - left.calls || left.toolName.localeCompare(right.toolName),
  );
  let toolCalls = state.unattributedCalls;
  let toolFailures = state.unattributedFailures;
  for (const tally of tallies) {
    toolCalls += tally.calls;
    toolFailures += tally.failed;
  }
  const retries: TurnRetryTally[] = [];
  for (const reason of RETRY_REASONS) {
    const tally = state.retries[reason];
    if (tally !== undefined) retries.push({ reason, count: tally.count, waitMs: tally.waitMs });
  }
  const kept = tallies.slice(0, MAX_TURN_DIAGNOSTIC_TOOLS);
  return {
    toolCalls,
    toolFailures,
    ...(kept.length > 0 ? { tools: kept } : {}),
    ...(tallies.length > kept.length ? { toolsTruncated: true as const } : {}),
    ...(retries.length > 0 ? { retries } : {}),
    ...(state.approvalRequests > 0 ? { approvalRequests: state.approvalRequests } : {}),
    ...(state.inputRequests > 0 ? { inputRequests: state.inputRequests } : {}),
    ...(state.rateLimitWarnings > 0 ? { rateLimitWarnings: state.rateLimitWarnings } : {}),
    ...(state.rateLimitExhausted ? { rateLimitExhausted: true as const } : {}),
    ...(state.compactions > 0 ? { compactions: state.compactions } : {}),
    ...(state.outputStopReason === undefined ? {} : { outputStopReason: state.outputStopReason }),
    ...(state.failure === undefined ? {} : { failure: state.failure }),
  };
}

const RETRY_REASONS: ReadonlyArray<RetryReason> = [
  "rate-limited",
  "unavailable",
  "stream-interrupted",
  "empty-completion",
];
