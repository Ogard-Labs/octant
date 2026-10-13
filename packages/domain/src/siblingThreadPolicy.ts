import type {
  CodeThreadId,
  OctantMode,
  ProjectId,
  SiblingThreadAction,
  SiblingThreadReference,
  SiblingThreadRefuseReason,
} from "@octant/contracts";
import {
  DEFAULT_SIBLING_THREAD_WAIT_MS,
  MAX_SIBLING_THREAD_LIST_ROWS,
  MAX_SIBLING_THREAD_READS_PER_TURN,
  MAX_SIBLING_THREAD_WAITS_PER_TURN,
  MAX_SIBLING_THREAD_WAIT_MS,
  decodeCodeThreadId,
  decodeProjectId,
  decodeSiblingThreadReference,
} from "@octant/contracts";

/**
 * Pure policy for the sibling-threads tool: which threads a Code turn may
 * list, read, and wait on, how a reference resolves, and the per-turn bounds.
 * Nothing here reads storage or grants authority; the host supplies the facts
 * on every call and owns the taint, the journal, and the transcript read.
 */

/**
 * The one sentence every reference outside the readable set refuses with. An
 * unknown or malformed reference, a thread of another Project, the caller, a
 * child run, and a thread completed, archived, or deleted since it was listed
 * all read the same, so a refusal never confirms that a thread exists.
 */
export const SIBLING_THREAD_UNREACHABLE = "That thread cannot be read from this thread.";

/** Where the calling turn stands. */
export interface SiblingThreadCaller {
  readonly threadId: CodeThreadId;
  /** Absent for a thread outside any Project, which reads nothing. */
  readonly projectId: ProjectId | undefined;
  readonly mode: OctantMode;
}

/**
 * One thread the host resolved. Only real threads resolve: a child run is
 * not a thread here and never reaches this policy, the same as for agent
 * messaging, so its id refuses as an unknown one.
 */
export interface SiblingThreadFacts {
  readonly threadId: CodeThreadId;
  readonly projectId: ProjectId | undefined;
  readonly mode: OctantMode;
  /** Completed or archived. A deleted thread does not resolve at all. */
  readonly closed: boolean;
}

/**
 * Whether the caller may see a thread: both are Code threads, the target is
 * another, still-open thread of the caller's own Project. A Project has one
 * mode, so today this is Code to Code; Chat and Work conversations are never
 * callers or targets.
 */
export function siblingThreadReadable(
  caller: SiblingThreadCaller,
  target: SiblingThreadFacts,
): boolean {
  return (
    caller.mode === "code" &&
    target.mode === "code" &&
    caller.projectId !== undefined &&
    target.projectId !== undefined &&
    String(caller.projectId) === String(target.projectId) &&
    String(target.threadId) !== String(caller.threadId) &&
    !target.closed
  );
}

/** The reference `list` returns for a readable thread. */
export function siblingThreadReference(target: {
  readonly threadId: CodeThreadId;
  readonly projectId: ProjectId;
}): SiblingThreadReference {
  return decodeSiblingThreadReference(`${String(target.threadId)}@${String(target.projectId)}`);
}

/**
 * The thread and Project a reference names, or `undefined` for text that is
 * not a reference. The host resolves the thread from this before it asks
 * {@link decideSiblingThreadTarget}.
 */
export function parseSiblingThreadReference(
  reference: string,
): { readonly threadId: CodeThreadId; readonly projectId: ProjectId } | undefined {
  try {
    const [threadId, projectId] = decodeSiblingThreadReference(reference).split("@");
    return { threadId: decodeCodeThreadId(threadId), projectId: decodeProjectId(projectId) };
  } catch {
    return undefined;
  }
}

export type SiblingThreadTargetDecision =
  | { readonly status: "admitted"; readonly target: SiblingThreadFacts }
  | {
      readonly status: "refused";
      readonly reason: Extract<SiblingThreadRefuseReason, "unauthorized">;
      readonly message: string;
    };

/**
 * Resolve a `read` or `wait` reference against the thread the host found for
 * it now. The reference must name exactly that thread and the Project both
 * threads are in now, and the thread must still be readable; every other
 * case is the same refusal.
 */
export function decideSiblingThreadTarget(input: {
  readonly caller: SiblingThreadCaller;
  readonly reference: string;
  readonly target: SiblingThreadFacts | undefined;
}): SiblingThreadTargetDecision {
  const named = parseSiblingThreadReference(input.reference);
  if (
    named === undefined ||
    input.target === undefined ||
    String(named.threadId) !== String(input.target.threadId) ||
    String(named.projectId) !== String(input.target.projectId) ||
    !siblingThreadReadable(input.caller, input.target)
  ) {
    return { status: "refused", reason: "unauthorized", message: SIBLING_THREAD_UNREACHABLE };
  }
  return { status: "admitted", target: input.target };
}

/**
 * The rows `list` returns: the readable threads among the host's candidates,
 * most recently changed first, at most {@link MAX_SIBLING_THREAD_LIST_ROWS},
 * with `truncated` saying whether any readable thread was left out.
 */
export function listSiblingThreads<
  T extends SiblingThreadFacts & { readonly stateChangedAt: string },
>(
  caller: SiblingThreadCaller,
  candidates: ReadonlyArray<T>,
): { readonly threads: ReadonlyArray<T>; readonly truncated: boolean } {
  const readable = candidates
    .filter((candidate) => siblingThreadReadable(caller, candidate))
    .toSorted(
      (left, right) =>
        Date.parse(right.stateChangedAt) - Date.parse(left.stateChangedAt) ||
        String(left.threadId).localeCompare(String(right.threadId)),
    );
  return {
    threads: readable.slice(0, MAX_SIBLING_THREAD_LIST_ROWS),
    truncated: readable.length > MAX_SIBLING_THREAD_LIST_ROWS,
  };
}

export type SiblingThreadCallDecision =
  | { readonly status: "admitted" }
  | {
      readonly status: "refused";
      readonly reason: Extract<SiblingThreadRefuseReason, "rate-limited">;
      readonly message: string;
    };

/**
 * Whether this turn may make another call of `action`, given the calls of
 * each kind it has already made. `list` is not counted: it returns titles and
 * states only, and the reads it leads to are.
 */
export function decideSiblingThreadCall(input: {
  readonly action: SiblingThreadAction;
  readonly readsThisTurn: number;
  readonly waitsThisTurn: number;
}): SiblingThreadCallDecision {
  if (input.action === "read" && input.readsThisTurn >= MAX_SIBLING_THREAD_READS_PER_TURN) {
    return {
      status: "refused",
      reason: "rate-limited",
      message: `This turn has already read ${String(MAX_SIBLING_THREAD_READS_PER_TURN)} threads.`,
    };
  }
  if (input.action === "wait" && input.waitsThisTurn >= MAX_SIBLING_THREAD_WAITS_PER_TURN) {
    return {
      status: "refused",
      reason: "rate-limited",
      message: `This turn has already waited ${String(MAX_SIBLING_THREAD_WAITS_PER_TURN)} times.`,
    };
  }
  return { status: "admitted" };
}

/** How long one `wait` blocks: the caller's timeout within the bound, or the default. */
export function siblingThreadWaitMs(requested: number | undefined): number {
  if (requested === undefined || !Number.isFinite(requested)) return DEFAULT_SIBLING_THREAD_WAIT_MS;
  return Math.min(Math.max(Math.trunc(requested), 0), MAX_SIBLING_THREAD_WAIT_MS);
}

/**
 * Whether an action brings text another thread wrote into the caller's turn,
 * and so must mark the caller with `thread.external-content-ingested@1`
 * before it returns. A title is such text, so `list` does; `wait` returns a
 * closed set of states and does not.
 */
export function siblingThreadActionIngestsContent(action: SiblingThreadAction): boolean {
  return action !== "wait";
}
