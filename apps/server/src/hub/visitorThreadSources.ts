// What a visitor link reads of a thread on this spoke, per mode. Only message
// text leaves here: Code's prompts and replies from its message-search view,
// Chat's messages and replies from its thread view, and Work's prompts and
// replies from its turns' transcripts, with the reply still streaming. Tool calls, diffs, files, attachments
// and approvals never enter these reads; an approval shows only as the
// thread's state.
//
// The state follows the run, not the messages: a reply that is still streaming
// is working, and a turn stopped before it replied is idle.

import {
  decodeChatThreadId,
  decodeCodeThreadId,
  decodeWorkThreadId,
  type ChatAttemptOutcome,
  type CodeThread,
  type CodeThreadId,
  type WorkThread,
  type WorkThreadId,
  type WorkTurnState,
} from "@octant/contracts";
import { activeChatTurns, parkedStopReleased } from "@octant/domain";
import { readChatThreadView } from "../persistence/chatProjection";
import { readCodeThread } from "../persistence/codeProjection";
import type { SqliteConnection } from "../persistence/sqlitePort";
import type { VisitorThreadRead, VisitorThreadSource } from "./spokeVisitorService";

const MAX_MESSAGES = 200;
const MISSING = { status: "missing" } as const;

type Message = { readonly role: "person" | "agent"; readonly text: string };
type VisitorThreadState = Extract<VisitorThreadRead, { status: "found" }>["state"];

/**
 * Whether a Code thread's turn runs or waits on the person, as its sidebar row
 * says. The projection this source reads does not hold it; the Code service does.
 */
export type CodeTurnActivity = (threadId: CodeThreadId) => {
  readonly executing?: boolean;
  readonly awaitingInput?: boolean;
};

/** A Code thread's state as a visitor reads it, from its lifecycle and its turn's activity. */
export function codeVisitorState(
  lifecycle: CodeThread["lifecycle"],
  activity: ReturnType<CodeTurnActivity>,
): VisitorThreadState {
  if (lifecycle === "waiting" || activity.awaitingInput === true) return "owner-deciding";
  return activity.executing === true ? "working" : "idle";
}

/** A Chat turn's latest attempt, as the visitor's state reads it. */
export type ChatLatestAttempt = {
  readonly outcome: ChatAttemptOutcome;
  /** The attempt is parked on its account's usage limit, not on a question. */
  readonly usageLimitStop: boolean;
};

/**
 * A Chat thread's state as a visitor reads it, from each turn's latest attempt
 * in order. Regenerating an older reply adds its attempt to that older turn, so
 * a run or a question on any turn counts, not only on the last. A usage-limit
 * stop is different: it waits on the owner only while it is the last turn's
 * and no move to another account released it; an older one is history.
 */
export function chatVisitorState(
  latest: ReadonlyArray<ChatLatestAttempt | undefined>,
  lastStopReleased: boolean,
): VisitorThreadState {
  if (latest.some((attempt) => attempt?.outcome === "queued" || attempt?.outcome === "streaming")) {
    return "working";
  }
  const deciding = latest.some((attempt, index) => {
    if (attempt?.outcome !== "waiting") return false;
    if (!attempt.usageLimitStop) return true;
    return index === latest.length - 1 && !lastStopReleased;
  });
  return deciding ? "owner-deciding" : "idle";
}

/** What a Work thread's state is read from: the same activity its board row shows. */
export type WorkTurnActivity = {
  readonly executing: boolean;
  readonly awaitingInput: boolean;
  /** `awaitingInput` is only because the latest turn is parked, as on a usage-limit stop. */
  readonly waitsOnTurnAlone?: boolean;
};

/**
 * A Work thread's state as a visitor reads it. A question, an approval, or a
 * waiting child is the owner deciding, as on Code. A usage-limit stop parks
 * the latest turn as waiting: it waits on the owner until a move to another
 * account released it, as on Chat, and is idle after.
 */
export function workVisitorState(
  activity: WorkTurnActivity,
  latest: { readonly usageLimitStop: boolean } | undefined,
  latestStopReleased: boolean,
): VisitorThreadState {
  const releasedLimitStop =
    activity.waitsOnTurnAlone === true && latest?.usageLimitStop === true && latestStopReleased;
  if (activity.awaitingInput && !releasedLimitStop) return "owner-deciding";
  return activity.executing ? "working" : "idle";
}

/**
 * The Work threads and turns this host holds in memory, and each thread's
 * activity. Only the fields named here are read; a turn's tool steps, files,
 * attachments and response record are never looked at.
 */
export interface WorkVisitorThreads {
  readonly thread: (
    threadId: WorkThreadId,
  ) => Pick<WorkThread, "title" | "lifecycle" | "providerHandoff"> | undefined;
  readonly turns: (threadId: WorkThreadId) => ReadonlyArray<{
    readonly requestId: WorkTurnState["requestId"];
    readonly turnId: string;
    readonly status: WorkTurnState["status"];
    readonly failure?: { readonly usageLimit?: unknown } | undefined;
    readonly transcript: ReadonlyArray<{
      readonly role: "user" | "assistant";
      readonly text: string;
    }>;
  }>;
  /** The reply an unsettled turn has streamed so far; the journaled transcript lacks it. */
  readonly liveReplyText: (requestId: WorkTurnState["requestId"]) => string | undefined;
  readonly activity: (threadId: WorkThreadId) => WorkTurnActivity;
}

function readWork(work: WorkVisitorThreads | undefined, threadId: string): VisitorThreadRead {
  if (work === undefined) return MISSING;
  let id;
  try {
    id = decodeWorkThreadId(threadId);
  } catch {
    return MISSING;
  }
  const thread = work.thread(id);
  if (thread === undefined || thread.lifecycle === "deleting" || thread.lifecycle === "deleted") {
    return MISSING;
  }
  const turns = work.turns(id);
  const messages: Message[] = turns.flatMap((turn) => {
    const live = work.liveReplyText(turn.requestId);
    const transcript =
      live === undefined
        ? turn.transcript
        : [
            ...turn.transcript.filter((entry) => entry.role === "user"),
            { role: "assistant" as const, text: live },
          ];
    return transcript
      .filter((entry) => entry.text.trim() !== "")
      .map(
        (entry): Message => ({
          role: entry.role === "user" ? "person" : "agent",
          text: entry.text,
        }),
      );
  });
  const latest = turns.at(-1);
  return {
    status: "found",
    title: thread.title,
    archived: thread.lifecycle === "archived",
    state: workVisitorState(
      work.activity(id),
      latest === undefined
        ? undefined
        : {
            usageLimitStop: latest.status === "waiting" && latest.failure?.usageLimit !== undefined,
          },
      parkedStopReleased(thread, latest === undefined ? undefined : String(latest.turnId)),
    ),
    messages: messages.slice(-MAX_MESSAGES),
  };
}

function readCode(
  connection: SqliteConnection,
  activity: CodeTurnActivity,
  threadId: string,
): VisitorThreadRead {
  let id;
  try {
    id = decodeCodeThreadId(threadId);
  } catch {
    return MISSING;
  }
  const thread = readCodeThread(connection, id);
  if (thread === undefined) return MISSING;
  const rows = connection
    .prepare(`
      SELECT content_role, body_text
      FROM code_transcript_search_projection
      WHERE thread_id = ? AND rewound = 0
      ORDER BY start_sequence DESC, content_role ASC
      LIMIT ?
    `)
    .all(threadId, MAX_MESSAGES) as ReadonlyArray<{
    readonly content_role: "user" | "assistant";
    readonly body_text: string;
  }>;
  // A completed turn's prompt and reply share a sequence. Newest first, the
  // reply comes before its prompt here, so the reversal below puts the prompt first.
  const messages: Message[] = rows
    .filter((row) => row.body_text.trim() !== "")
    .map(
      (row): Message => ({
        role: row.content_role === "user" ? "person" : "agent",
        text: row.body_text,
      }),
    )
    .reverse();
  return {
    status: "found",
    title: thread.title,
    archived: thread.lifecycle === "archived",
    state: codeVisitorState(thread.lifecycle, activity(id)),
    messages,
  };
}

function readChat(connection: SqliteConnection, threadId: string): VisitorThreadRead {
  let id;
  try {
    id = decodeChatThreadId(threadId);
  } catch {
    return MISSING;
  }
  const view = readChatThreadView(connection, id);
  if (
    view === undefined ||
    view.thread.lifecycle === "deleting" ||
    view.thread.lifecycle === "deleted"
  ) {
    return MISSING;
  }
  const bodies = new Map(view.contents.map((content) => [String(content.contentId), content]));
  const textOf = (contentId: string, role: "user" | "assistant") => {
    const content = bodies.get(contentId);
    return content?.role === role ? content.body : undefined;
  };
  const messages: Message[] = [];
  const turns = activeChatTurns(view.turns);
  for (const turn of turns) {
    const asked = textOf(String(turn.userMessageRef.contentId), "user");
    if (asked !== undefined) messages.push({ role: "person", text: asked });
    const latest = turn.attempts.at(-1);
    const reply = (latest?.responseRefs ?? [])
      .map((ref) => textOf(String(ref.contentId), "assistant"))
      .filter((text): text is string => text !== undefined)
      .join("");
    if (reply !== "") messages.push({ role: "agent", text: reply });
  }
  const lastAttempt = turns.at(-1)?.attempts.at(-1);
  const lastAttemptId = lastAttempt === undefined ? undefined : String(lastAttempt.id);
  return {
    status: "found",
    title: view.thread.title,
    archived: view.thread.lifecycle === "archived",
    state: chatVisitorState(
      turns.map((turn) => {
        const attempt = turn.attempts.at(-1);
        return attempt === undefined
          ? undefined
          : { outcome: attempt.outcome, usageLimitStop: attempt.usageLimit !== undefined };
      }),
      parkedStopReleased(view.thread, lastAttemptId),
    ),
    messages: messages.slice(-MAX_MESSAGES),
  };
}

/**
 * Reads Code and Chat threads from this host's projections, Code's turn
 * activity from its service, and Work threads from Work's own projections;
 * without them a Work thread is missing.
 */
export function visitorThreadSource(
  connection: () => SqliteConnection,
  codeActivity: CodeTurnActivity,
  work?: WorkVisitorThreads,
): VisitorThreadSource {
  return {
    read: (mode, threadId) =>
      mode === "code"
        ? readCode(connection(), codeActivity, threadId)
        : mode === "work"
          ? readWork(work, threadId)
          : readChat(connection(), threadId),
  };
}
