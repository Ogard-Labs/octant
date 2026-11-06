import type {
  CodeBoardView,
  CodePlannerWorkProposal,
  CodeThread,
  WindowId,
} from "@octant/contracts";

/**
 * Ceiling on cards one board read hands the provider. The board is ordered by
 * most recent meaningful activity, so the planner always sees the live end of
 * a Project that has outgrown the bound.
 */
export const MAX_PLANNER_BOARD_CARDS = 100;

/**
 * What the planner capability lends one thread's agent: a read of its own
 * Project's server-authoritative board (the threads tool's `board`), and an
 * advisory proposal that waits for the person (a side task offered with
 * target `board`). Both re-resolve the planner designation on every call, so
 * only the currently designated planner thread ever gets an answer, and
 * neither can mutate a thread, a checkout, or GitHub.
 */
export interface CodePlannerToolPort {
  /**
   * Whether this thread is currently its Project's designated planner. Used
   * only to decide whether the planner's operations are advertised at all;
   * every call still re-validates through {@link board} and {@link propose}.
   */
  readonly isPlannerThread: (threadId: CodeThread["id"]) => boolean;
  readonly board: (
    windowId: WindowId,
    threadId: CodeThread["id"],
  ) => Promise<
    | { readonly status: "ok"; readonly board: CodeBoardView }
    | { readonly status: "refused"; readonly reason: string; readonly message: string }
  >;
  readonly propose: (
    windowId: WindowId,
    threadId: CodeThread["id"],
    draft: { readonly title: string; readonly intent: string; readonly rationale?: string },
  ) => Promise<
    | { readonly status: "proposed"; readonly proposal: CodePlannerWorkProposal }
    | { readonly status: "refused"; readonly reason: string; readonly message: string }
  >;
}

export type PlannerBoardAnswer =
  | {
      readonly status: "ok";
      readonly result: {
        readonly status: "board";
        readonly generatedAt: string;
        readonly cards: ReadonlyArray<Record<string, unknown>>;
        readonly truncated?: true;
      };
    }
  | { readonly status: "refused"; readonly reason: string; readonly message: string };

/**
 * The planner's board read: the same server read-model the board UI queries,
 * scoped to the planner's own Project, cut to {@link MAX_PLANNER_BOARD_CARDS}
 * with `truncated` stated. A port that throws is the host's failure and is
 * answered as one.
 */
export async function readPlannerBoard(
  port: CodePlannerToolPort,
  windowId: WindowId,
  threadId: CodeThread["id"],
): Promise<PlannerBoardAnswer> {
  let outcome: Awaited<ReturnType<CodePlannerToolPort["board"]>>;
  try {
    outcome = await port.board(windowId, threadId);
  } catch {
    return {
      status: "refused",
      reason: "planner-unavailable",
      message: "The Project board is unavailable on this host.",
    };
  }
  if (outcome.status === "refused") return outcome;
  const cards = outcome.board.cards.slice(0, MAX_PLANNER_BOARD_CARDS);
  return {
    status: "ok",
    result: {
      status: "board",
      generatedAt: String(outcome.board.generatedAt),
      cards: cards.map((card) => ({
        threadId: String(card.threadId),
        title: card.title,
        status: card.status,
        statusReason: card.statusReason,
        outcomeKind: card.outcomeKind,
        deliverySatisfaction: card.deliverySatisfaction,
        executing: card.executing,
        changedFiles: card.changedFiles,
        linkedPullRequest: card.linkedPullRequest,
        checks: card.checks,
        reviewState: card.reviewState,
        childAgents: card.childAgents,
        planProgress: card.planProgress,
        followUp: card.followUp,
        ...(card.blockingReason === undefined ? {} : { blockingReason: card.blockingReason }),
        lastMeaningfulActivityAt: card.lastMeaningfulActivityAt,
      })),
      ...(outcome.board.cards.length > cards.length ? { truncated: true as const } : {}),
    },
  };
}
