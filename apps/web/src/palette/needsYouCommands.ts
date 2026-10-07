import type { OctantMode } from "@octant/contracts/modes";
import type { PendingRequest } from "@octant/contracts/pending-requests";
import type { CommandThread } from "./buildOctantCommands";
import type { OctantCommand } from "./commandModel";

export type ApprovalPendingRequest = Extract<PendingRequest, { readonly kind: "approval" }>;
export type ApprovalDecision = "approved" | "denied";

/**
 * What the palette needs to turn the host's pending-request read into rows.
 * Both callbacks are the ones the visible controls already use: opening a
 * thread, and answering through the mode's own answer command.
 */
export interface NeedsYouSources {
  readonly requests: ReadonlyArray<PendingRequest>;
  /** Wall clock for the wait shown beside each thread. */
  readonly nowMs: number;
  readonly onOpenThread: (thread: CommandThread) => void;
  readonly onAnswerApproval: (request: ApprovalPendingRequest, decision: ApprovalDecision) => void;
}

const MODE_LABEL: Record<OctantMode, string> = { chat: "Chat", work: "Work", code: "Code" };

/** A palette row is one line; the full request stays in the thread. */
const MAX_TEXT_CHARACTERS = 64;

/**
 * One row per waiting thread, oldest wait first, plus an Approve and a Deny
 * command for each approval. A question's choices are not listed: answering one
 * needs the whole question on screen, so its row opens the thread instead.
 * Nothing is listed when nothing waits, so the group never shows empty.
 */
export function buildNeedsYouCommands(sources: NeedsYouSources): ReadonlyArray<OctantCommand> {
  const threads = new Map<string, Array<PendingRequest>>();
  for (const request of sources.requests) {
    const key = `${request.mode}:${String(request.threadId)}`;
    const existing = threads.get(key);
    if (existing === undefined) threads.set(key, [request]);
    else existing.push(request);
  }

  const commands: Array<OctantCommand> = [];
  for (const [key, requests] of threads) {
    const first = requests[0];
    if (first === undefined) continue;
    const thread: CommandThread = {
      threadId: String(first.threadId),
      title: first.threadTitle,
      mode: first.mode,
      ...(first.projectId === undefined ? {} : { projectId: String(first.projectId) }),
    };
    commands.push({
      id: `needs-you:thread:${key}`,
      title: first.threadTitle,
      group: "Needs you",
      detail: [
        MODE_LABEL[first.mode],
        waitingOn(requests),
        waited(sources.nowMs - Date.parse(first.requestedAt)),
      ].join(" · "),
      keywords: ["waiting", "needs you", "question", "approval", first.threadTitle],
      action: { kind: "run", run: () => sources.onOpenThread(thread) },
    });
    for (const request of requests) {
      if (request.kind !== "approval") continue;
      const detail = `${MODE_LABEL[request.mode]} · ${shorten(request.text)}`;
      for (const decision of ["approved", "denied"] as const) {
        const verb = decision === "approved" ? "Approve" : "Deny";
        commands.push({
          id: `needs-you:${decision}:${request.mode}:${approvalKey(request)}`,
          title: `${verb}: ${request.threadTitle}`,
          group: "Needs you",
          detail,
          keywords: [verb, "approval", request.threadTitle],
          action: { kind: "run", run: () => sources.onAnswerApproval(request, decision) },
        });
      }
    }
  }
  return commands;
}

function waitingOn(requests: ReadonlyArray<PendingRequest>): string {
  const approval = requests.some((request) => request.kind === "approval");
  const question = requests.some((request) => request.kind === "question");
  if (approval && question) return "waiting on approval and your answer";
  return approval ? "waiting on approval" : "waiting on your answer";
}

function waited(elapsedMs: number): string {
  const minutes = Math.floor(Math.max(0, elapsedMs) / 60_000);
  if (minutes < 1) return "<1m";
  if (minutes < 60) return `${String(minutes)}m`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${String(hours)}h` : `${String(Math.floor(hours / 24))}d`;
}

function shorten(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length <= MAX_TEXT_CHARACTERS ? line : `${line.slice(0, MAX_TEXT_CHARACTERS - 1)}…`;
}

function approvalKey(request: ApprovalPendingRequest): string {
  return "approvalId" in request.answer
    ? String(request.answer.approvalId)
    : String(request.answer.requestId);
}
