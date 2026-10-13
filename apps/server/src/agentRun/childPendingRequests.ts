import {
  decodePendingRequest,
  MAX_CHILD_PENDING_REQUEST_TASK_LENGTH,
  MAX_CHILD_PENDING_REQUEST_TEXT_LENGTH,
  type AgentRun,
  type AgentRunId,
  type NativeHarnessInteractionSource,
  type NativeHarnessSessionView,
  type PendingRequest,
  type UtcTimestamp,
} from "@octant/contracts";
import type { NativeHarnessApprovalStore } from "../harness/nativeHarnessApprovals";
import type { NativeHarnessQuestionStore } from "../harness/nativeHarnessQuestions";

export interface ChildPendingRequestSources {
  readonly approvals: Pick<NativeHarnessApprovalStore, "waiting">;
  readonly questions: Pick<NativeHarnessQuestionStore, "waiting">;
  readonly readSession: (threadId: string) => NativeHarnessSessionView | undefined;
  readonly getRun: (id: AgentRunId) => AgentRun | undefined;
  readonly parentThreadTitle: (run: AgentRun) => string | undefined;
  /** The authorization the harness session route applies before it shows a thread's session. */
  readonly authorizeThread: (input: {
    readonly threadId: string;
    readonly windowId: string;
  }) => boolean | Promise<boolean>;
}

/**
 * The subagent approvals and questions a window could answer from the parent
 * thread's Agents tab, as rows that find the request and cannot answer it.
 *
 * Only a request with a live waiter is listed, so one that expired, was
 * cancelled, or was lost to a restart is never offered. Each waiter is matched
 * to the pending item the session journaled, and only an item that names its
 * run is a subagent's: a lead's own approval or question is not listed here.
 * A Chat parent has no Agents tab to answer in, so its subagents are not listed.
 * Anything that cannot be matched, read, or authorized is left out, never
 * guessed at, because a row for a request the Agents tab cannot show would
 * send the person to a place with nothing to answer.
 */
export async function listChildPendingRequests(
  sources: ChildPendingRequestSources,
  windowId: string,
): Promise<ReadonlyArray<PendingRequest>> {
  const waiting = [
    ...sources.approvals
      .waiting()
      .map(({ threadId, approvalId }) => ({ kind: "approval" as const, threadId, id: approvalId })),
    ...sources.questions
      .waiting()
      .map(({ threadId, questionId }) => ({ kind: "question" as const, threadId, id: questionId })),
  ];
  const authorized = new Map<string, boolean>();
  const requests: PendingRequest[] = [];
  for (const wait of waiting) {
    const view = sources.readSession(wait.threadId);
    if (view === undefined) continue;
    const item = pendingItem(view, wait);
    if (item === undefined) continue;
    const run = sources.getRun(item.source.runId);
    if (run === undefined || String(run.parentThreadId) !== wait.threadId) continue;
    if (run.routingReceipt.mode === "chat") continue;
    const title = sources.parentThreadTitle(run)?.trim();
    if (title === undefined || title.length === 0) continue;
    let mayOpen = authorized.get(wait.threadId);
    if (mayOpen === undefined) {
      mayOpen = await sources.authorizeThread({ threadId: wait.threadId, windowId });
      authorized.set(wait.threadId, mayOpen);
    }
    if (!mayOpen) continue;
    const text = cut(item.text, MAX_CHILD_PENDING_REQUEST_TEXT_LENGTH);
    const task = cut(run.task, MAX_CHILD_PENDING_REQUEST_TASK_LENGTH);
    if (text === undefined || task === undefined) continue;
    try {
      requests.push(
        decodePendingRequest({
          mode: run.routingReceipt.mode,
          kind: wait.kind === "approval" ? "child-approval" : "child-question",
          ...(run.workspaceReceipt.kind === "chat-virtual"
            ? {}
            : { projectId: run.workspaceReceipt.projectId }),
          threadId: wait.threadId,
          threadTitle: title,
          child: {
            runId: run.id,
            role: run.role,
            task,
            ...(item.source.providerName === undefined
              ? {}
              : { providerName: item.source.providerName }),
            modelId: item.source.modelId,
          },
          text,
          requestedAt: item.askedAt,
        }),
      );
    } catch {
      // A row the contract refuses is left out; it must not fail the whole read.
    }
  }
  return requests;
}

function pendingItem(
  view: NativeHarnessSessionView,
  wait: { readonly kind: "approval" | "question"; readonly id: string },
):
  | {
      readonly source: NativeHarnessInteractionSource;
      readonly text: string;
      readonly askedAt: UtcTimestamp;
    }
  | undefined {
  const item =
    wait.kind === "approval"
      ? view.approvals?.find((entry) => String(entry.id) === wait.id)
      : view.questions.find((entry) => String(entry.id) === wait.id);
  if (item === undefined || item.status !== "pending" || item.source === undefined) {
    return undefined;
  }
  return {
    source: item.source,
    text: "summary" in item ? item.summary : item.prompt,
    askedAt: item.askedAt,
  };
}

function cut(value: string, max: number): string | undefined {
  const text = value.slice(0, max).trim();
  return text.length === 0 ? undefined : text;
}
