import type { CodeThread, CodeThreadId } from "@octant/contracts/code";
import {
  decodeCodeOperationId,
  type CodeConversationTurn,
  type CodeOperationId,
} from "@octant/contracts";
import { refreshNewestTurns } from "@octant/domain";
import type { LoadEarlierMessagesState } from "../transcript/LoadEarlierMessages";
import type { CodeConversationMessage, CodeTurnUsage } from "./codeControllerState";

/** How many turns a Code thread opens on, and how many each Load earlier adds. */
export const CODE_CONVERSATION_PAGE_TURNS = 20;

/**
 * How many forks deep Load earlier follows a thread's lineage. The same bound
 * the whole-history read used, so a cycle a corrupt record could describe
 * ends in a refusal rather than a loop.
 */
export const MAX_CODE_FORK_LINEAGE = 32;

/** Where the inherited history of a fork goes on: one source thread's page anchor. */
export interface CodeInheritedCursor {
  readonly threadId: CodeThreadId;
  readonly anchor: { readonly through: CodeOperationId } | { readonly before: CodeOperationId };
  /** Threads already read on the way here, the open thread first. */
  readonly lineage: ReadonlyArray<string>;
}

/**
 * What the open thread holds of its history beyond the newest page.
 *
 * The thread's own turns come first: `ownHasEarlier` says whether any are
 * older than the oldest loaded one. A fork then continues into its source at
 * the fork point and up the lineage; `inherited` is unset until the first
 * inherited page is read, a cursor while more remains, and `complete` once
 * the start of the lineage is loaded. `offered` stays set once the thread has
 * offered earlier messages, so the row keeps its place after the last page.
 */
export interface CodeEarlierConversation {
  readonly threadKey: string | undefined;
  readonly ownHasEarlier: boolean;
  readonly inherited: CodeInheritedCursor | "complete" | undefined;
  readonly offered: boolean;
  readonly loading: "idle" | "loading" | "failed";
}

export const NO_EARLIER_CONVERSATION: CodeEarlierConversation = {
  threadKey: undefined,
  ownHasEarlier: false,
  inherited: undefined,
  offered: false,
  loading: "idle",
};

/** The page Load earlier reads next. */
export type CodeEarlierRead =
  | { readonly kind: "own"; readonly before: CodeOperationId }
  | { readonly kind: "inherited"; readonly cursor: CodeInheritedCursor }
  | { readonly kind: "none" };

/** The oldest of the thread's own turns that is loaded, or undefined when none is. */
export function oldestOwnOperation(
  messages: ReadonlyArray<CodeConversationMessage>,
): CodeOperationId | undefined {
  return messages.find(
    (message) => message.sourceThreadId === undefined && message.operationId !== undefined,
  )?.operationId;
}

export function nextEarlierRead(
  state: CodeEarlierConversation,
  messages: ReadonlyArray<CodeConversationMessage>,
  forkedFrom: CodeThread["forkedFrom"],
): CodeEarlierRead {
  const oldest = oldestOwnOperation(messages);
  if (state.ownHasEarlier && oldest !== undefined) return { kind: "own", before: oldest };
  if (state.inherited === "complete") return { kind: "none" };
  if (state.inherited !== undefined) return { kind: "inherited", cursor: state.inherited };
  if (forkedFrom === undefined || state.threadKey === undefined) return { kind: "none" };
  return {
    kind: "inherited",
    cursor: {
      threadId: forkedFrom.threadId,
      anchor: { through: decodeCodeOperationId(forkedFrom.throughOperationId) },
      lineage: [state.threadKey],
    },
  };
}

/** The Load earlier row, or undefined for a thread that never had earlier messages. */
export function earlierRowState(
  state: CodeEarlierConversation,
  messages: ReadonlyArray<CodeConversationMessage>,
  forkedFrom: CodeThread["forkedFrom"],
): LoadEarlierMessagesState | undefined {
  const next = nextEarlierRead(state, messages, forkedFrom);
  if (!state.offered && next.kind === "none") return undefined;
  if (state.loading !== "idle") return state.loading;
  return next.kind === "none" ? "none-left" : "idle";
}

/**
 * Join a freshly read newest window onto what the thread shows. When the
 * window's first turn is loaded, everything before it stays: earlier pages,
 * and the fork's inherited turns before them. Otherwise the window replaces
 * the thread's own turns; the inherited turns stay only while the window
 * reaches the thread's first turn, since only then do they still touch it.
 */
export function joinNewestWindow(
  current: ReadonlyArray<CodeConversationMessage>,
  newest: ReadonlyArray<CodeConversationMessage>,
  hasEarlier: boolean,
): {
  readonly kind: "spliced" | "replaced";
  readonly messages: ReadonlyArray<CodeConversationMessage>;
} {
  const refreshed = refreshNewestTurns(current, newest, (message) => message.id);
  if (refreshed.kind === "spliced") return { kind: "spliced", messages: refreshed.turns };
  if (hasEarlier) return { kind: "replaced", messages: newest };
  const inherited = current.filter((message) => message.sourceThreadId !== undefined);
  return { kind: "replaced", messages: [...inherited, ...newest] };
}

/**
 * Each loaded own turn's usage, oldest first, so the latest figures in the
 * total are the newest turn's. Turns the page read just carried take their
 * figure from it; others keep the figure already held, live reports included.
 */
export function loadedTurnUsage(
  messages: ReadonlyArray<CodeConversationMessage>,
  read: ReadonlyArray<CodeConversationTurn>,
  held: ReadonlyMap<string, CodeTurnUsage>,
): Map<string, CodeTurnUsage> {
  const fromRead = new Map(read.map((turn) => [String(turn.operationId), turn.usage]));
  const usage = new Map<string, CodeTurnUsage>();
  for (const message of messages) {
    if (message.sourceThreadId !== undefined || message.operationId === undefined) continue;
    const key = String(message.operationId);
    if (usage.has(key)) continue;
    const figure = fromRead.has(key) ? fromRead.get(key) : held.get(key);
    if (figure !== undefined) usage.set(key, figure);
  }
  return usage;
}
