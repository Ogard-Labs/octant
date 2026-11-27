// What a visitor link reads of a thread on this spoke, per mode. Only message
// text leaves here: Code's prompts and replies from its message-search view,
// and Chat's messages and replies from its thread view. Tool calls, diffs,
// files, attachments and approvals never enter these reads; an approval shows
// only as the thread's state. A Work thread has no such read yet.
//
// The state follows the run, not the messages: a reply that is still streaming
// is working, and a turn stopped before it replied is idle.

import {
  decodeChatThreadId,
  decodeCodeThreadId,
  type ChatAttemptOutcome,
  type CodeThread,
  type CodeThreadId,
} from "@octant/contracts";
import { activeChatTurns } from "@octant/domain";
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

/** A Chat thread's state as a visitor reads it, from its last turn's latest attempt. */
export function chatVisitorState(outcome: ChatAttemptOutcome | undefined): VisitorThreadState {
  if (outcome === "queued" || outcome === "streaming") return "working";
  return outcome === "waiting" ? "owner-deciding" : "idle";
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
  return {
    status: "found",
    title: view.thread.title,
    archived: view.thread.lifecycle === "archived",
    state: chatVisitorState(turns.at(-1)?.attempts.at(-1)?.outcome),
    messages: messages.slice(-MAX_MESSAGES),
  };
}

/** Reads Code and Chat threads from this host's projections, and Code's turn activity from its service. */
export function visitorThreadSource(
  connection: () => SqliteConnection,
  codeActivity: CodeTurnActivity,
): VisitorThreadSource {
  return {
    read: (mode, threadId) =>
      mode === "code"
        ? readCode(connection(), codeActivity, threadId)
        : readChat(connection(), threadId),
  };
}
