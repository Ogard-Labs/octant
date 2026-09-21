import type {
  WindowId,
  WorkThreadId,
  WorkTurnLookupResult,
  WorkTurnStreamFrame,
} from "@octant/contracts";
import { decodeWorkTurnRequestId } from "@octant/contracts";
import type { GoalLoopRoundOutcome } from "./goalLoopService";
import type { WorkTurnUsageStore } from "../work/workTurnUsageStore";

/** The Work turn surface the runner drives, narrowed to what a round needs. */
export interface GoalLoopWorkTurnPort {
  readonly startFirstTurn: (windowId: WindowId, command: unknown) => Promise<WorkTurnLookupResult>;
  readonly subscribe: (
    windowId: WindowId,
    threadId: WorkThreadId,
    afterSequence: number,
    signal: AbortSignal,
  ) => AsyncGenerator<WorkTurnStreamFrame>;
  /** The live feed cursor for a thread, so the runner subscribes from now. */
  readonly liveCursor: (threadId: WorkThreadId) => number;
}

/** Everything the runner needs to build the one turn a round is. */
export interface GoalLoopWorkRoundInput {
  readonly threadId: string;
  readonly objective: string;
}

export interface CreateGoalLoopWorkRoundRunnerOptions {
  readonly turns: GoalLoopWorkTurnPort;
  readonly usage: WorkTurnUsageStore;
  /** The window the turn runs in; absent means no local renderer can own it. */
  readonly windowId: () => WindowId | undefined;
  /** Builds the ordinary Work turn command for this thread and objective. */
  readonly command: (input: GoalLoopWorkRoundInput) => {
    readonly kind: "start-work-thread-turn";
    readonly requestId: string;
    readonly threadId: string;
    readonly turnId: string;
    readonly prompt: string;
    readonly authority: Record<string, unknown>;
  };
  readonly uuid: () => string;
  readonly now?: () => number;
}

const TERMINAL_TURN_STATUSES = new Set(["completed", "cancelled", "failed", "waiting"]);

/**
 * One goal-loop round is one ordinary Work turn, reported only once the turn
 * itself has settled.
 *
 * The previous wiring resolved when startFirstTurn accepted the turn, so the
 * round was journaled while the provider was still running and its spend was
 * recorded as zero. This runner waits for the same turn-settled frame the
 * renderer sees, so the round it reports is the round that happened: real
 * elapsed time, provider-reported tokens when the provider reported any, and
 * a failed round — never a silent success — when the turn never settles.
 */
export function createGoalLoopWorkRoundRunner(
  options: CreateGoalLoopWorkRoundRunnerOptions,
): (input: GoalLoopWorkRoundInput) => Promise<GoalLoopRoundOutcome> {
  const now = options.now ?? Date.now;
  return async (input) => {
    const windowId = options.windowId();
    if (windowId === undefined) {
      return {
        outcome: "failed",
        tokensSpent: 0,
        elapsedMs: 0,
        detail: "No local window is available to run the round.",
      };
    }
    const controller = new AbortController();
    const startedAt = now();
    let settled: Extract<WorkTurnLookupResult, { kind: "accepted" }> | undefined;
    let requestId: ReturnType<typeof decodeWorkTurnRequestId> | undefined;
    try {
      const command = options.command(input);
      requestId = decodeWorkTurnRequestId(command.requestId);
      // Subscribe before the turn starts: a subscription created after the
      // provider's first event would see a frame gap and be sent home with a
      // snapshot-required instead of the settlement this runner waits for.
      const frames = options.turns.subscribe(
        windowId,
        input.threadId as never as WorkThreadId,
        options.turns.liveCursor(input.threadId as never as WorkThreadId),
        controller.signal,
      );
      const accepted = await options.turns.startFirstTurn(windowId, command);
      if (accepted.kind !== "accepted") {
        return {
          outcome: "failed",
          tokensSpent: 0,
          elapsedMs: now() - startedAt,
          detail:
            accepted.kind === "not-created" || accepted.kind === "ambiguous"
              ? accepted.message
              : "Work turn was not accepted.",
        };
      }
      if (TERMINAL_TURN_STATUSES.has(accepted.turn.status)) {
        settled = accepted;
      } else {
        for await (const frame of frames) {
          if (frame.kind !== "turn-settled") continue;
          if (String(frame.turn.requestId) !== String(requestId)) continue;
          settled = { kind: "accepted", turn: frame.turn };
          break;
        }
      }
    } catch (error) {
      return {
        outcome: "failed",
        tokensSpent: 0,
        elapsedMs: now() - startedAt,
        detail: error instanceof Error ? error.message : "The goal-loop round failed.",
      };
    } finally {
      controller.abort();
    }
    if (settled === undefined) {
      return {
        outcome: "failed",
        tokensSpent: 0,
        elapsedMs: now() - startedAt,
        detail: "Work turn ended without a settled state the loop could read.",
      };
    }
    const turn = settled.turn;
    const elapsedMs = now() - startedAt;
    if (turn.status === "completed") {
      const usage = requestId === undefined ? undefined : options.usage.take(requestId);
      return {
        outcome: "ran",
        tokensSpent: usage === undefined ? 0 : usage.inputTokens + usage.outputTokens,
        elapsedMs,
      };
    }
    if (turn.status === "waiting") {
      return {
        outcome: "failed",
        tokensSpent: 0,
        elapsedMs,
        detail: "Work turn is waiting for a person to continue it.",
      };
    }
    return {
      outcome: "failed",
      tokensSpent: 0,
      elapsedMs,
      detail: turn.failure === undefined ? `Work turn ${turn.status}.` : turn.failure.message,
    };
  };
}
