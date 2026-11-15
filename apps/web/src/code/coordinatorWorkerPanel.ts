import type { ThreadBoardPullRequestSummary } from "@octant/contracts";
import { codeThreadActivity } from "../shell/shellModeRouting";
import type { CodeThreadNavigationItem } from "./useCodeController";

/**
 * Where a worker stands, in the words the Workers panel and a transcript card
 * use (docs/design/workspace.md#coordinators). It is read from the same host
 * facts the sidebar status uses, never from agent text.
 */
export type CoordinatorWorkerState = "needs-you" | "working" | "idle" | "in-review" | "done";

export const COORDINATOR_WORKER_STATE_WORDS: Readonly<Record<CoordinatorWorkerState, string>> = {
  "needs-you": "Needs you",
  working: "Working",
  idle: "Idle",
  "in-review": "In review",
  done: "Done",
};

/** The thread facts the panel reads; the window's Code thread list carries them. */
export type CoordinatorWorkerSource = Pick<
  CodeThreadNavigationItem,
  | "threadId"
  | "title"
  | "projectId"
  | "providerInstanceId"
  | "lifecycle"
  | "coordinatorThreadId"
  | "completedAt"
  | "markedDone"
  | "executing"
  | "awaitingInput"
  | "followUp"
  | "unread"
  | "pullRequestSummaries"
  | "modelId"
  | "updatedAt"
  | "createdAt"
>;

export interface CoordinatorWorkerRow {
  readonly threadId: string;
  readonly title: string;
  readonly projectId: CoordinatorWorkerSource["projectId"];
  readonly state: CoordinatorWorkerState;
  readonly modelLabel: string;
  readonly pullRequest?: ThreadBoardPullRequestSummary;
  readonly updatedAt?: string;
  readonly createdAt?: string;
}

/**
 * Needs you outranks everything, so a request is never filed under another
 * word. A worker whose person marked it Done, or whose pull request merged or
 * closed, is Done; one with a pull request still open is In review.
 */
export function coordinatorWorkerState(thread: CoordinatorWorkerSource): CoordinatorWorkerState {
  const activity = codeThreadActivity(thread);
  if (activity === "attention") return "needs-you";
  if (thread.completedAt !== undefined || thread.markedDone === true) return "done";
  const pullRequests = thread.pullRequestSummaries?.items ?? [];
  if (pullRequests.length > 0) {
    return pullRequests.some(
      (pullRequest) => pullRequest.state !== "merged" && pullRequest.state !== "closed",
    )
      ? "in-review"
      : "done";
  }
  return activity === "working" ? "working" : "idle";
}

/**
 * The coordinator's workers from the window's Code thread list, newest change
 * first. The Agents tool's Workers section reads the same list; a worker this
 * window cannot see is never listed.
 */
export function coordinatorWorkerRows(
  threads: ReadonlyArray<CoordinatorWorkerSource>,
  coordinatorThreadId: string,
  modelLabel: (thread: CoordinatorWorkerSource) => string,
): ReadonlyArray<CoordinatorWorkerRow> {
  return threads
    .filter(
      (thread) =>
        thread.coordinatorThreadId !== undefined &&
        String(thread.coordinatorThreadId) === coordinatorThreadId,
    )
    .map((thread): CoordinatorWorkerRow => {
      const pullRequest = thread.pullRequestSummaries?.items[0];
      return {
        threadId: String(thread.threadId),
        title: thread.title,
        projectId: thread.projectId,
        state: coordinatorWorkerState(thread),
        modelLabel: modelLabel(thread),
        ...(pullRequest === undefined ? {} : { pullRequest }),
        ...(thread.updatedAt === undefined ? {} : { updatedAt: String(thread.updatedAt) }),
        ...(thread.createdAt === undefined ? {} : { createdAt: thread.createdAt }),
      };
    })
    .sort((left, right) => (right.updatedAt ?? "").localeCompare(left.updatedAt ?? ""));
}

export interface CoordinatorWorkerSections {
  readonly needsYou: ReadonlyArray<CoordinatorWorkerRow>;
  /** Working and idle workers: neither delivered nor done. */
  readonly working: ReadonlyArray<CoordinatorWorkerRow>;
  readonly inReview: ReadonlyArray<CoordinatorWorkerRow>;
  readonly done: ReadonlyArray<CoordinatorWorkerRow>;
}

export function coordinatorWorkerSections(
  rows: ReadonlyArray<CoordinatorWorkerRow>,
): CoordinatorWorkerSections {
  return {
    needsYou: rows.filter((row) => row.state === "needs-you"),
    working: rows.filter((row) => row.state === "working" || row.state === "idle"),
    inReview: rows.filter((row) => row.state === "in-review"),
    done: rows.filter((row) => row.state === "done"),
  };
}
