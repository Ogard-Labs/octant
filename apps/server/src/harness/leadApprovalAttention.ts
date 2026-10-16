import {
  decodePendingRequest,
  type NativeHarnessApproval,
  type NativeHarnessSession,
  type OctantMode,
  type PendingRequest,
  type ProjectId,
} from "@octant/contracts";
import { modeText } from "../agentRun/childPendingRequests";
import type { NativeHarnessApprovalStore } from "./nativeHarnessApprovals";
import type { NativeHarnessSessionStore } from "./nativeHarnessSessionStore";

export interface LeadApprovalSources {
  readonly approvals: Pick<NativeHarnessApprovalStore, "waiting">;
  readonly sessions: Pick<
    NativeHarnessSessionStore,
    "pendingLeadApprovals" | "threadsWithPendingLeadApprovals"
  >;
}

/**
 * The agent's own harness approval a person has not answered. It is the same
 * wait a question is: the thread cannot go on until someone decides.
 *
 * `lostInRestart` is an approval the journal still holds as pending although no
 * running turn waits on it, as after a host restart. The call it guarded died
 * with the process, so nothing can run for it; the session needs resuming, and
 * the lead asks again if it still wants the call.
 */
export interface LeadApproval {
  readonly threadId: string;
  readonly mode: OctantMode;
  readonly projectId?: ProjectId;
  readonly approval: NativeHarnessApproval;
  readonly lostInRestart: boolean;
}

/**
 * The oldest approval the thread's lead is waiting on a person for, or nothing.
 * A subagent's approval is not the lead's and is read elsewhere. Only an
 * approval a turn is blocked on right now counts, or one a restart left behind
 * in a session that is waiting to be resumed; an expired, cancelled, or
 * answered approval is settled in the journal and never counts.
 */
export function leadApprovalFor(
  sources: LeadApprovalSources,
  threadId: string,
): LeadApproval | undefined {
  const pending = sources.sessions.pendingLeadApprovals(threadId);
  if (pending === undefined) return undefined;
  const waiting = new Set(
    sources.approvals
      .waiting()
      .filter((entry) => entry.threadId === threadId)
      .map((entry) => entry.approvalId),
  );
  for (const approval of pending.approvals) {
    if (waiting.has(String(approval.id)))
      return describe(threadId, pending.session, approval, false);
  }
  const oldest = pending.approvals[0];
  return oldest !== undefined && pending.session.status === "recovery-required"
    ? describe(threadId, pending.session, oldest, true)
    : undefined;
}

/** Whether the thread's lead is waiting on a person for an approval. */
export function awaitsLeadApproval(sources: LeadApprovalSources, threadId: string): boolean {
  return leadApprovalFor(sources, threadId) !== undefined;
}

/** Every thread whose lead is waiting on a person for an approval. */
export function leadApprovals(sources: LeadApprovalSources): ReadonlyArray<LeadApproval> {
  return sources.sessions.threadsWithPendingLeadApprovals().flatMap((threadId) => {
    const found = leadApprovalFor(sources, threadId);
    return found === undefined ? [] : [found];
  });
}

function describe(
  threadId: string,
  session: NativeHarnessSession,
  approval: NativeHarnessApproval,
  lostInRestart: boolean,
): LeadApproval {
  return {
    threadId,
    mode: session.mode,
    ...(session.projectId === undefined ? {} : { projectId: session.projectId }),
    approval,
    lostInRestart,
  };
}

export interface LeadApprovalRowSources extends LeadApprovalSources {
  /**
   * The thread's title and Project as its own record holds them now, or
   * nothing for a thread that is gone. The session keeps the Project it was
   * started under, which a moved Chat thread has left.
   */
  readonly threadFacts: (input: {
    readonly threadId: string;
    readonly mode: OctantMode;
  }) => { readonly title: string; readonly projectId?: ProjectId | undefined } | undefined;
  /**
   * Whether this window may open the thread. That is the project binding, not
   * the harness session route: the session route also requires the thread to
   * be the open surface, which would hide the row everywhere except the thread
   * the person is already on.
   */
  readonly authorizeThread: (input: {
    readonly threadId: string;
    readonly mode: OctantMode;
    readonly projectId: ProjectId | undefined;
    readonly windowId: string;
  }) => boolean | Promise<boolean>;
}

/**
 * The approvals a window could answer from the thread itself, as rows that find
 * the request and cannot answer it. Answering stays on the harness session
 * route, which checks the window and the principal before anything is decided,
 * so this read adds no way to approve.
 *
 * Text keeps each mode's own bounds and sanitization, and the thread's title
 * and Project are read from its own record, not the session's snapshot. A thread
 * that cannot be titled, authorized, or described to the contract is left out,
 * never guessed at.
 */
export async function listLeadApprovalRequests(
  sources: LeadApprovalRowSources,
  windowId: string,
): Promise<ReadonlyArray<PendingRequest>> {
  const requests: PendingRequest[] = [];
  for (const lead of leadApprovals(sources)) {
    const facts = sources.threadFacts({ threadId: lead.threadId, mode: lead.mode });
    const title = facts?.title.trim();
    if (facts === undefined || title === undefined || title.length === 0) continue;
    const mayOpen = await sources.authorizeThread({
      threadId: lead.threadId,
      mode: lead.mode,
      projectId: facts.projectId,
      windowId,
    });
    if (!mayOpen) continue;
    const text = approvalText(lead.mode, lead.approval.summary);
    if (text === undefined) continue;
    try {
      requests.push(
        decodePendingRequest({
          mode: lead.mode,
          kind: "lead-approval",
          ...(facts.projectId === undefined ? {} : { projectId: facts.projectId }),
          threadId: lead.threadId,
          threadTitle: title,
          text,
          ...(lead.lostInRestart ? { lostInRestart: true } : {}),
          requestedAt: lead.approval.askedAt,
        }),
      );
    } catch {
      // A row the contract refuses is left out; it must not fail the whole read.
    }
  }
  return requests;
}

/**
 * The approval text as the thread's own mode would carry it: Work and Code are
 * cut and redacted as a subagent's request is, and Chat keeps the harness
 * summary as written.
 */
function approvalText(mode: OctantMode, value: string): string | undefined {
  if (mode !== "chat") return modeText(mode, "approval", value);
  const text = value.trim();
  return text.length === 0 ? undefined : text;
}
