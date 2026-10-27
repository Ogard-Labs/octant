import {
  decodePendingRequest,
  type NativeHarnessApproval,
  type NativeHarnessQuestion,
  type NativeHarnessSession,
  type OctantMode,
  type PendingRequest,
  type ProjectId,
} from "@octant/contracts";
import { modeText } from "../agentRun/childPendingRequests";
import type { NativeHarnessApprovalStore } from "./nativeHarnessApprovals";
import type { NativeHarnessQuestionStore } from "./nativeHarnessQuestions";
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

export interface LeadQuestionSources {
  readonly questions: Pick<NativeHarnessQuestionStore, "waiting">;
  readonly sessions: Pick<NativeHarnessSessionStore, "pendingLeadQuestions">;
}

/** The lead's own `ask-user` question a turn is blocked on right now. */
export interface LeadQuestion {
  readonly threadId: string;
  readonly mode: OctantMode;
  readonly projectId?: ProjectId;
  readonly question: NativeHarnessQuestion;
}

/**
 * The oldest question the thread's lead is blocked on right now, or nothing.
 * A subagent's question is not the lead's and is read elsewhere. Unlike an
 * approval, a question a restart left pending does not count: nothing
 * receives an answer to it, the session already asks to be resumed, and the
 * turn it cut off says so on its own. An answered, cancelled, or expired
 * question has no waiter and never counts.
 */
export function leadQuestionFor(
  sources: LeadQuestionSources,
  threadId: string,
): LeadQuestion | undefined {
  const waiting = new Set(
    sources.questions
      .waiting()
      .filter((entry) => entry.threadId === threadId)
      .map((entry) => entry.questionId),
  );
  if (waiting.size === 0) return undefined;
  const pending = sources.sessions.pendingLeadQuestions(threadId);
  const question = pending?.questions.find((entry) => waiting.has(String(entry.id)));
  if (pending === undefined || question === undefined) return undefined;
  return {
    threadId,
    mode: pending.session.mode,
    ...(pending.session.projectId === undefined ? {} : { projectId: pending.session.projectId }),
    question,
  };
}

/** Whether the thread's lead is blocked on its own `ask-user` question right now. */
export function awaitsLeadQuestion(sources: LeadQuestionSources, threadId: string): boolean {
  return leadQuestionFor(sources, threadId) !== undefined;
}

/** Every thread whose lead is blocked on its own question right now. */
export function leadQuestions(sources: LeadQuestionSources): ReadonlyArray<LeadQuestion> {
  const threads = new Set(sources.questions.waiting().map((entry) => entry.threadId));
  return [...threads].flatMap((threadId) => {
    const found = leadQuestionFor(sources, threadId);
    return found === undefined ? [] : [found];
  });
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

/** How a lead's row learns whether, and as what, a window may find its thread. */
export interface LeadRowAccess {
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

export interface LeadApprovalRowSources extends LeadApprovalSources, LeadRowAccess {}

export interface LeadQuestionRowSources extends LeadQuestionSources, LeadRowAccess {}

/**
 * The thread's title and Project as its own record holds them now, when the
 * window may open it; nothing for a thread that is gone, untitled, or out of
 * the window's reach.
 */
async function findableThread(
  access: LeadRowAccess,
  input: { readonly threadId: string; readonly mode: OctantMode },
  windowId: string,
): Promise<{ readonly title: string; readonly projectId?: ProjectId | undefined } | undefined> {
  const facts = access.threadFacts({ threadId: input.threadId, mode: input.mode });
  const title = facts?.title.trim();
  if (facts === undefined || title === undefined || title.length === 0) return undefined;
  const mayOpen = await access.authorizeThread({
    threadId: input.threadId,
    mode: input.mode,
    projectId: facts.projectId,
    windowId,
  });
  return mayOpen ? { title, projectId: facts.projectId } : undefined;
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
    const thread = await findableThread(sources, lead, windowId);
    if (thread === undefined) continue;
    const text = approvalText(lead.mode, lead.approval.summary);
    if (text === undefined) continue;
    try {
      requests.push(
        decodePendingRequest({
          mode: lead.mode,
          kind: "lead-approval",
          ...(thread.projectId === undefined ? {} : { projectId: thread.projectId }),
          threadId: lead.threadId,
          threadTitle: thread.title,
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
 * A Work lead's questions as rows that find the question and cannot answer it.
 * The thread's inline question card answers it through the harness session
 * route, which checks the window and the principal first, so this read adds no
 * way to answer. A Code lead's question is already a Code question with its
 * own answer handle, and a Chat lead's question parks the Chat attempt and is
 * listed as a Chat question, so only Work is listed here. The rules are the
 * approval rows': the thread's own title and Project, the window's reach, and
 * Work's sanitized text.
 */
export async function listLeadQuestionRequests(
  sources: LeadQuestionRowSources,
  windowId: string,
): Promise<ReadonlyArray<PendingRequest>> {
  const requests: PendingRequest[] = [];
  for (const lead of leadQuestions(sources)) {
    if (lead.mode !== "work") continue;
    const thread = await findableThread(sources, lead, windowId);
    if (thread === undefined) continue;
    const text = modeText("work", "question", lead.question.prompt);
    if (text === undefined) continue;
    try {
      requests.push(
        decodePendingRequest({
          mode: "work",
          kind: "lead-question",
          projectId: thread.projectId,
          threadId: lead.threadId,
          threadTitle: thread.title,
          text,
          requestedAt: lead.question.askedAt,
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
