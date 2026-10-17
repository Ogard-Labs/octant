import {
  AgentRunCenterResponse,
  AgentRunConversationResponse,
  AgentRunResultsResponse,
  type AgentRunCenterSummary,
  type NativeHarnessSessionView,
  decodeHostAnswer,
} from "@octant/contracts";
import { answerAgentQuestion, refusalMessage, type HostRefusal } from "./agentHost";
import type { OpenedLocalControlSession } from "./localControl";

/**
 * The helper agents a thread's lead started, as the terminal shows them: the
 * same server projections the app's Agents tab reads (the Agents Center list,
 * a child's bounded conversation and result packets) and the same controls
 * (steer a running child, follow up on a finished one, answer a question it
 * asked). The host authorizes every read and command against the window the
 * terminal opened the thread in; nothing here widens that.
 */

export type AgentChild = AgentRunCenterSummary;

/** The most a conversation read shows of one child, so a long run stays readable. */
const MAX_REPLY_CHARACTERS = 4_000;

/** The thread's helper agents, oldest first, so a number keeps meaning the same child. */
export async function listAgentChildren(
  session: OpenedLocalControlSession,
  threadId: string,
): Promise<
  HostRefusal | { readonly kind: "listed"; readonly children: ReadonlyArray<AgentChild> }
> {
  const response = await session.send({
    path: `/api/agent-runs/center?status=all&mode=all&parentThreadId=${encodeURIComponent(threadId)}`,
    method: "GET",
  });
  if (response.status !== 200) {
    return {
      kind: "refused",
      message: refusalMessage(response, "The helper agents could not be read."),
    };
  }
  const items = decodeHostAnswer(AgentRunCenterResponse)(response.body).items;
  return {
    kind: "listed",
    children: [...items].sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
  };
}

/** One child by its list number or the start of its id; undefined when none or several match. */
export function pickAgentChild(
  children: ReadonlyArray<AgentChild>,
  reference: string,
): AgentChild | undefined {
  if (/^\d+$/.test(reference)) return children[Number(reference) - 1];
  if (reference.length < 4) return undefined;
  const matches = children.filter((child) => String(child.runId).startsWith(reference));
  return matches.length === 1 ? matches[0] : undefined;
}

export interface AgentChildRead {
  /** What the child said: its final result when it has one, else its live text. */
  readonly reply: string | undefined;
  readonly blockers: ReadonlyArray<string>;
  /** The host could not give a live read (the child ended, or it runs inside its provider). */
  readonly conversationNote: string | undefined;
}

/** A child's reply and blockers from the host's own reads; a failed read leaves that part out. */
export async function readAgentChild(
  session: OpenedLocalControlSession,
  child: AgentChild,
): Promise<AgentChildRead> {
  const runId = encodeURIComponent(String(child.runId));
  const [results, conversation] = await Promise.all([
    session.send({ path: `/api/agent-runs/results?runId=${runId}`, method: "GET" }),
    session.send({ path: `/api/agent-runs/conversation?runId=${runId}`, method: "GET" }),
  ]);
  const packet =
    results.status === 200
      ? decodeHostAnswer(AgentRunResultsResponse)(results.body).packets.at(-1)
      : undefined;
  const live =
    conversation.status === 200
      ? decodeHostAnswer(AgentRunConversationResponse)(conversation.body)
      : undefined;
  const liveText = live?.entries
    .filter((entry) => entry.kind === "assistant")
    .map((entry) => entry.text)
    .join("")
    .trim();
  const final = packet?.reportedSummary.text?.trim();
  const reply = final !== undefined && final.length > 0 ? final : liveText;
  return {
    reply:
      reply === undefined || reply.length === 0
        ? undefined
        : reply.length > MAX_REPLY_CHARACTERS
          ? `…${reply.slice(-MAX_REPLY_CHARACTERS)}`
          : reply,
    blockers: packet?.blockers.items.map((item) => item.text) ?? [],
    conversationNote:
      live === undefined
        ? "The conversation is not available."
        : live.status === "stale" || live.status === "unavailable"
          ? (live.staleReason ?? "The live conversation is not available.")
          : undefined,
  };
}

const STATUS_WORDS: Readonly<Record<string, string>> = {
  queued: "queued",
  starting: "starting",
  running: "working",
  waiting: "waiting",
  completed: "done",
  failed: "failed",
  interrupted: "interrupted",
  cancelled: "cancelled",
};

const ROLE_WORDS: Readonly<Record<string, string>> = {
  research: "research",
  implementation: "implement",
  review: "review",
  custom: "custom",
};

export function childStatusWord(child: AgentChild): string {
  return STATUS_WORDS[child.lifecycleStatus] ?? child.lifecycleStatus;
}

/** Time since the child's state last changed, compactly: "12s", "4m", "2h", "3d". */
export function childAge(since: string, now: number): string {
  const seconds = Math.max(0, Math.round((now - Date.parse(since)) / 1_000));
  if (!Number.isFinite(seconds)) return "";
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3_600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3_600)}h`;
  return `${Math.floor(seconds / 86_400)}d`;
}

function oneLine(text: string, limit: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= limit ? flat : `${flat.slice(0, limit - 1)}…`;
}

/** The question a helper is waiting on the person for, from the harness session. */
export function childQuestion(
  session: NativeHarnessSessionView | null | "unavailable" | undefined,
  child: AgentChild,
): NativeHarnessSessionView["questions"][number] | undefined {
  if (session === null || session === undefined || session === "unavailable") return undefined;
  return session.questions.find(
    (question) =>
      question.status === "pending" &&
      question.source !== undefined &&
      String(question.source.runId) === String(child.runId),
  );
}

/** The list: number, state, role, model, age, then the brief. */
export function childListLines(
  children: ReadonlyArray<AgentChild>,
  now: number,
  waitingOn: ReadonlySet<string> = new Set(),
): ReadonlyArray<string> {
  if (children.length === 0) {
    return ["No helper agents yet. They appear when the lead hands off part of its work."];
  }
  return children.map((child, index) => {
    const facts = [
      childStatusWord(child),
      ROLE_WORDS[child.role] ?? child.role,
      String(child.route.executionModelId),
      childAge(child.updatedAt, now),
    ].filter((part) => part.length > 0);
    const asks = waitingOn.has(String(child.runId)) ? "  · asks you" : "";
    return `${index + 1}. [${String(child.runId).slice(0, 8)}] ${facts.join(" · ")}${asks} — ${oneLine(child.task, 80)}`;
  });
}

/** One child: its state and brief, what it said, anything blocking it, and how to reply. */
export function childDetailLines(
  child: AgentChild,
  read: AgentChildRead,
  question: NativeHarnessSessionView["questions"][number] | undefined,
  now: number,
): ReadonlyArray<string> {
  const lines = [
    `${childStatusWord(child)} · ${ROLE_WORDS[child.role] ?? child.role} · ${String(child.route.executionModelId)} · ${childAge(child.updatedAt, now)} · ${String(child.runId).slice(0, 8)}`,
    `Brief: ${child.task}`,
  ];
  if (child.recoveryReason !== undefined) lines.push(child.recoveryReason);
  if (question !== undefined) {
    lines.push(`Asks you: ${question.prompt}`);
    question.options.forEach((option, index) => lines.push(`  ${index + 1}. ${option}`));
  }
  if (read.reply !== undefined) lines.push("Reply:", read.reply);
  else lines.push("No reply yet.");
  for (const blocker of read.blockers) lines.push(`Blocked: ${blocker}`);
  if (read.conversationNote !== undefined && read.reply === undefined) {
    lines.push(read.conversationNote);
  }
  lines.push(replyHint(child, question !== undefined));
  return lines;
}

function replyHint(child: AgentChild, asks: boolean): string {
  if (asks) return "Answer it with: /agent <n> <answer>";
  if (child.executionKind !== "octant-managed") {
    return "It runs inside its provider; Octant can read it but not reply to it.";
  }
  if (child.lifecycleStatus === "running" || child.lifecycleStatus === "waiting") {
    return "Steer it with: /agent <n> <message>";
  }
  if (child.lifecycleStatus === "completed") return "Follow up with: /agent <n> <message>";
  return "";
}

/**
 * Replies to a helper the way the app does. A question it asked is answered
 * through the session's question route; a running or waiting child is steered
 * with a note; a finished one gets a follow-up that resumes it. A child that
 * runs inside its provider, or has failed or stopped, takes no reply and the
 * refusal says so.
 */
export async function replyToAgentChild(
  session: OpenedLocalControlSession,
  threadId: string,
  child: AgentChild,
  message: string,
  question: NativeHarnessSessionView["questions"][number] | undefined,
): Promise<
  HostRefusal | { readonly kind: "replied"; readonly how: "answered" | "steered" | "followed-up" }
> {
  if (question !== undefined) {
    const picked = /^\d+$/.test(message) ? question.options[Number(message) - 1] : undefined;
    const answered = await answerAgentQuestion(
      session,
      threadId,
      String(question.id),
      picked ?? message,
    );
    return answered.kind === "answered" ? { kind: "replied", how: "answered" } : answered;
  }
  if (child.executionKind !== "octant-managed") {
    return {
      kind: "refused",
      message: "It runs inside its provider; Octant can read it but not reply to it.",
    };
  }
  const steering = child.lifecycleStatus === "running" || child.lifecycleStatus === "waiting";
  if (!steering && child.lifecycleStatus !== "completed") {
    return {
      kind: "refused",
      message: `This helper is ${childStatusWord(child)}, so it takes no reply.`,
    };
  }
  const response = await session.send({
    path: steering ? "/api/agent-runs/steer" : "/api/agent-runs/resume",
    method: "POST",
    body: { runId: String(child.runId), expectedVersion: child.version, message },
  });
  const body = response.body as { readonly kind?: unknown; readonly message?: unknown };
  if (response.status !== 200 || body.kind === "run-command-failed") {
    return {
      kind: "refused",
      message:
        typeof body.message === "string" && body.message.length > 0
          ? body.message
          : refusalMessage(response, "The helper did not take the reply."),
    };
  }
  return { kind: "replied", how: steering ? "steered" : "followed-up" };
}
