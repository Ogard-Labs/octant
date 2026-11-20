import type { TurnLoopNotice, TurnStallNotice } from "@octant/contracts";

/**
 * Consecutive identical calls on one of Octant's own tools before the tool's
 * result includes an informational sentence noting the repetition.
 */
export const OCTANT_TOOL_EARLY_WARNING_THRESHOLD = 3;

/**
 * Consecutive identical calls to the same tool with the same canonical input
 * in one turn before Octant notices a loop (or stops the turn under Strict).
 */
export const TURN_LOOP_THRESHOLD = 6;

/**
 * Maximum pending tool starts remembered per turn so an unbounded Full-access
 * turn cannot leak memory if a runtime never reports a finish.
 */
const MAX_PENDING_TOOL_STARTS = 4_096;

/**
 * One informational sentence appended to the result of the 3rd consecutive
 * identical call to one of Octant's own tools. Never a refusal.
 */
export const OCTANT_TOOL_REPEAT_WARNING =
  "This tool has been called with the same input three times in a row.";

export type TurnToolOwner = "octant" | "provider";

export type TurnLoopOutcome =
  | {
      readonly kind: "notice";
      readonly toolName: string;
      readonly count: number;
    }
  | {
      readonly kind: "stop";
      readonly toolName: string;
      readonly count: number;
    };

export interface TurnLoopPendingStart {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly resolved: boolean;
  /** True once this unresolved start has already reset an earlier streak. */
  readonly streakBroken: boolean;
}

export interface TurnLoopState {
  readonly lastToolName: string | undefined;
  readonly lastCanonicalInput: string | undefined;
  readonly consecutiveCount: number;
  readonly loopNoticedForStreak: boolean;
  readonly pendingStarts: ReadonlyArray<TurnLoopPendingStart>;
}

export const INITIAL_TURN_LOOP_STATE: TurnLoopState = {
  lastToolName: undefined,
  lastCanonicalInput: undefined,
  consecutiveCount: 0,
  loopNoticedForStreak: false,
  pendingStarts: [],
};

export interface TurnLoopObservation {
  readonly next: TurnLoopState;
  readonly count: number;
  readonly earlyWarning: boolean;
  readonly loop: TurnLoopOutcome | undefined;
}

/**
 * Minimal slice of a normalized runtime event needed to track consecutive
 * identical tool calls across all providers.
 */
export type TurnLoopRuntimeEvent =
  | {
      readonly kind: "tool-start";
      readonly toolCallId: string;
      readonly toolName: string;
    }
  | {
      readonly kind: "tool-call-content";
      readonly toolCallId: string;
      readonly part: "input" | "output";
      readonly text: string;
      readonly truncated?: boolean;
      readonly partial?: boolean;
    }
  | {
      readonly kind: "tool-request";
      readonly requestId: string;
      readonly toolName: string;
      readonly inputJson: string;
    }
  | {
      readonly kind: "tool-success";
      readonly toolCallId: string;
    }
  | {
      readonly kind: "tool-failure";
      readonly toolCallId: string;
    }
  | {
      readonly kind: "task-progress" | "task-list" | "user-input-request";
    }
  | {
      readonly kind: string;
    };

/**
 * Canonical JSON serialization with recursively sorted object keys so two tool
 * calls with logically identical JSON objects compare equal regardless of key
 * order or formatting.
 */
export function canonicalToolInputJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalToolInputJson(entry)).join(",")}]`;
  }
  const record = value as Readonly<Record<string, unknown>>;
  const keys = Object.keys(record).sort((left, right) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
  const parts: string[] = [];
  for (const key of keys) {
    const entry = record[key];
    if (entry === undefined) continue;
    parts.push(`${JSON.stringify(key)}:${canonicalToolInputJson(entry)}`);
  }
  return `{${parts.join(",")}}`;
}

/**
 * Parses a JSON tool input string and returns its canonical sorted-key form,
 * or `undefined` when the string is not valid JSON and therefore cannot be
 * compared reliably.
 */
export function canonicalToolInputFromJson(inputJson: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(inputJson);
    return canonicalToolInputJson(parsed);
  } catch {
    return undefined;
  }
}

/** Resets the consecutive tool-call streak while keeping pending start correlation. */
export function resetTurnLoopStreak(state: TurnLoopState): TurnLoopState {
  if (
    state.lastToolName === undefined &&
    state.lastCanonicalInput === undefined &&
    state.consecutiveCount === 0 &&
    !state.loopNoticedForStreak
  ) {
    return state;
  }
  return {
    ...state,
    lastToolName: undefined,
    lastCanonicalInput: undefined,
    consecutiveCount: 0,
    loopNoticedForStreak: false,
  };
}

/**
 * Observes one tool call whose full JSON input is known and returns the next
 * loop state, whether an Octant-tool early warning should be appended, and
 * whether the 6-call loop threshold was reached.
 */
export function observeTurnToolCall(
  state: TurnLoopState,
  input: {
    readonly toolName: string;
    readonly inputJson: string;
    readonly owner: TurnToolOwner;
    readonly strict: boolean;
  },
): TurnLoopObservation {
  const canonicalInput = canonicalToolInputFromJson(input.inputJson);
  if (canonicalInput === undefined) {
    return {
      next: resetTurnLoopStreak(state),
      count: 0,
      earlyWarning: false,
      loop: undefined,
    };
  }
  const sameAsPrevious =
    state.lastToolName === input.toolName && state.lastCanonicalInput === canonicalInput;
  const count = sameAsPrevious ? state.consecutiveCount + 1 : 1;
  const alreadyNoticed = sameAsPrevious ? state.loopNoticedForStreak : false;
  const earlyWarning = input.owner === "octant" && count === OCTANT_TOOL_EARLY_WARNING_THRESHOLD;
  let loop: TurnLoopOutcome | undefined;
  let loopNoticedForStreak = alreadyNoticed;
  if (count >= TURN_LOOP_THRESHOLD && !alreadyNoticed) {
    loop = input.strict
      ? { kind: "stop", toolName: input.toolName, count }
      : { kind: "notice", toolName: input.toolName, count };
    loopNoticedForStreak = true;
  }
  return {
    next: {
      ...state,
      lastToolName: input.toolName,
      lastCanonicalInput: canonicalInput,
      consecutiveCount: count,
      loopNoticedForStreak,
    },
    count,
    earlyWarning,
    loop,
  };
}

function matchesStartedToolName(startedName: string, requestedName: string): boolean {
  return startedName === requestedName || startedName.endsWith(requestedName);
}

function appendPendingStart(
  pending: ReadonlyArray<TurnLoopPendingStart>,
  toolCallId: string,
  toolName: string,
  streakBroken: boolean,
): ReadonlyArray<TurnLoopPendingStart> {
  if (pending.some((entry) => entry.toolCallId === toolCallId)) return pending;
  const next = [...pending, { toolCallId, toolName, resolved: false, streakBroken }];
  return next.length > MAX_PENDING_TOOL_STARTS
    ? next.slice(next.length - MAX_PENDING_TOOL_STARTS)
    : next;
}

function markPendingStartResolved(
  pending: ReadonlyArray<TurnLoopPendingStart>,
  index: number,
): ReadonlyArray<TurnLoopPendingStart> {
  const target = pending[index];
  if (target === undefined || target.resolved) return pending;
  return pending.map((entry, current) =>
    current === index ? { ...entry, resolved: true } : entry,
  );
}

/**
 * If any earlier unresolved `tool-start` (before `beforeIndex`) has not yet
 * broken the prior streak, reset the streak now and mark those starts as
 * accounted for so overlapping tools never allow a later call to extend an
 * earlier streak.
 */
function accountForInterveningStarts(state: TurnLoopState, beforeIndex: number): TurnLoopState {
  const hasIntervening = state.pendingStarts.some(
    (entry, index) => index < beforeIndex && !entry.resolved && !entry.streakBroken,
  );
  if (!hasIntervening) return state;
  return {
    ...resetTurnLoopStreak(state),
    pendingStarts: state.pendingStarts.map((entry, index) =>
      index < beforeIndex && !entry.resolved && !entry.streakBroken
        ? { ...entry, streakBroken: true }
        : entry,
    ),
  };
}

/**
 * Observes a normalized provider runtime event for loop detection.
 *
 * - `tool-request` carries Octant's own app-managed tool calls with full JSON
 *   inputs (for Octant Harness, direct model endpoints, and bridged MCP/app
 *   tools across Claude Code, Codex, OpenCode, Pi, ACP, and outside drivers).
 * - `tool-start` paired with an un-truncated, non-partial `tool-call-content`
 *   (`part: "input"`) checks provider-native tools that report their JSON
 *   inputs (Claude Code).
 * - Any intervening tool call — even one still in flight or whose input is
 *   missing, truncated, or partial — resets the consecutive streak so another
 *   tool running in between never bridges two separate runs into a false loop.
 */
export function observeTurnRuntimeEvent(
  state: TurnLoopState,
  event: TurnLoopRuntimeEvent,
  options: { readonly strict: boolean },
): TurnLoopObservation {
  switch (event.kind) {
    case "tool-start": {
      const start = event as Extract<TurnLoopRuntimeEvent, { readonly kind: "tool-start" }>;
      const breaksPriorStreak =
        state.lastToolName !== undefined &&
        !matchesStartedToolName(start.toolName, state.lastToolName);
      const base = breaksPriorStreak ? resetTurnLoopStreak(state) : state;
      return {
        next: {
          ...base,
          pendingStarts: appendPendingStart(
            base.pendingStarts,
            start.toolCallId,
            start.toolName,
            breaksPriorStreak,
          ),
        },
        count: base.consecutiveCount,
        earlyWarning: false,
        loop: undefined,
      };
    }
    case "tool-call-content": {
      const content = event as Extract<
        TurnLoopRuntimeEvent,
        { readonly kind: "tool-call-content" }
      >;
      if (content.part !== "input") {
        return {
          next: state,
          count: state.consecutiveCount,
          earlyWarning: false,
          loop: undefined,
        };
      }
      const index = state.pendingStarts.findIndex(
        (entry) => entry.toolCallId === content.toolCallId,
      );
      if (index === -1) {
        return {
          next: state,
          count: state.consecutiveCount,
          earlyWarning: false,
          loop: undefined,
        };
      }
      const entry = state.pendingStarts[index];
      if (entry === undefined || entry.resolved) {
        return {
          next: state,
          count: state.consecutiveCount,
          earlyWarning: false,
          loop: undefined,
        };
      }
      const ordered = accountForInterveningStarts(state, index);
      const withResolved: TurnLoopState = {
        ...ordered,
        pendingStarts: markPendingStartResolved(ordered.pendingStarts, index),
      };
      if (content.truncated === true || content.partial === true) {
        return {
          next: resetTurnLoopStreak(withResolved),
          count: 0,
          earlyWarning: false,
          loop: undefined,
        };
      }
      return observeTurnToolCall(withResolved, {
        toolName: entry.toolName,
        inputJson: content.text,
        owner: "provider",
        strict: options.strict,
      });
    }
    case "tool-request": {
      const request = event as Extract<TurnLoopRuntimeEvent, { readonly kind: "tool-request" }>;
      // When a provider runtime (Claude, Codex, OpenCode, Pi, ACP) announces an
      // app-managed tool via `tool-start` before the bridge emits `tool-request`,
      // pair them so the start's completion does not reset the streak. Any
      // earlier unresolved start ahead of this call still breaks the prior streak.
      const matchIndex = state.pendingStarts.findIndex(
        (entry) => !entry.resolved && matchesStartedToolName(entry.toolName, request.toolName),
      );
      const ordered = accountForInterveningStarts(
        state,
        matchIndex === -1 ? state.pendingStarts.length : matchIndex,
      );
      const correlated: TurnLoopState =
        matchIndex === -1
          ? ordered
          : {
              ...ordered,
              pendingStarts: markPendingStartResolved(ordered.pendingStarts, matchIndex),
            };
      return observeTurnToolCall(correlated, {
        toolName: request.toolName,
        inputJson: request.inputJson,
        owner: "octant",
        strict: options.strict,
      });
    }
    case "tool-success":
    case "tool-failure": {
      const finished = event as Extract<
        TurnLoopRuntimeEvent,
        { readonly kind: "tool-success" | "tool-failure" }
      >;
      const index = state.pendingStarts.findIndex(
        (entry) => entry.toolCallId === finished.toolCallId,
      );
      if (index === -1) {
        return {
          next: state,
          count: state.consecutiveCount,
          earlyWarning: false,
          loop: undefined,
        };
      }
      const entry = state.pendingStarts[index];
      const nextPending = state.pendingStarts.filter((_, current) => current !== index);
      const base: TurnLoopState = { ...state, pendingStarts: nextPending };
      if (entry !== undefined && !entry.resolved && !entry.streakBroken) {
        return {
          next: resetTurnLoopStreak(base),
          count: 0,
          earlyWarning: false,
          loop: undefined,
        };
      }
      return {
        next: base,
        count: base.consecutiveCount,
        earlyWarning: false,
        loop: undefined,
      };
    }
    // Claude's task/checklist and AskUserQuestion tools suppress `tool-start`
    // and emit task or question events instead; treat them as an intervening
    // tool call so they break any preceding consecutive streak.
    case "task-progress":
    case "task-list":
    case "user-input-request":
      return {
        next: resetTurnLoopStreak(state),
        count: 0,
        earlyWarning: false,
        loop: undefined,
      };
    default:
      return {
        next: state,
        count: state.consecutiveCount,
        earlyWarning: false,
        loop: undefined,
      };
  }
}

/**
 * Adds one informational sentence to an Octant tool's result on the 3rd
 * identical consecutive call in one turn without discarding or refusing the
 * tool's real result.
 */
export function appendRepeatToolWarning(result: unknown): unknown {
  if (typeof result === "string") {
    return `${result}\n\n${OCTANT_TOOL_REPEAT_WARNING}`;
  }
  if (result !== null && typeof result === "object" && !Array.isArray(result)) {
    const record = result as Readonly<Record<string, unknown>>;
    if (record.notice === undefined) {
      return { ...record, notice: OCTANT_TOOL_REPEAT_WARNING };
    }
    if (typeof record.notice === "string") {
      return { ...record, notice: `${record.notice} ${OCTANT_TOOL_REPEAT_WARNING}` };
    }
    return { ...record, repeatNotice: OCTANT_TOOL_REPEAT_WARNING };
  }
  return {
    result: result === undefined ? null : result,
    notice: OCTANT_TOOL_REPEAT_WARNING,
  };
}

/**
 * What the stalled-turn limit does when a turn stays silent past its window:
 * under Strict it stops the turn; outside Strict it only notices and offers
 * Stop.
 */
export function decideTurnStallAction(input: { readonly strict: boolean }): "notice" | "stop" {
  return input.strict ? "stop" : "notice";
}

/** One quiet sentence for a loop notice or Strict loop stop in a thread. */
export function turnLoopNoticeSentence(notice: TurnLoopNotice): string {
  if (notice.kind === "turn-loop-stopped") {
    return `Stopped under Strict after ${notice.toolName} ran ${notice.count} times in a row with the same input.`;
  }
  return `Repeated ${notice.toolName} ${notice.count} times in a row with the same input.`;
}

function formatStallDuration(idleMs: number): string | undefined {
  if (idleMs < 60_000) return undefined;
  const totalMinutes = Math.round(idleMs / 60_000);
  if (totalMinutes < 60) {
    return totalMinutes === 1 ? "1 minute" : `${totalMinutes} minutes`;
  }
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (minutes === 0) {
    return hours === 1 ? "1 hour" : `${hours} hours`;
  }
  return `${hours}h ${minutes}m`;
}

/** One quiet sentence for a silent-turn notice outside Strict. */
export function turnStallNoticeSentence(notice: TurnStallNotice): string {
  const duration = formatStallDuration(notice.idleMs);
  return duration === undefined
    ? "No activity from the provider for a while."
    : `No activity from the provider for ${duration}.`;
}
