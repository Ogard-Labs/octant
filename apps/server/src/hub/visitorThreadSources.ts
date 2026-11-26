// What a visitor link reads of a thread on this spoke, per mode. Only message
// text leaves here: Code's prompts and replies from its message-search view,
// and Chat's messages and replies from its thread view. Tool calls, diffs,
// files, attachments and approvals never enter these reads; an approval shows
// only as the thread's state. A Work thread has no such read yet.

import { decodeChatThreadId, decodeCodeThreadId } from "@octant/contracts";
import { activeChatTurns } from "@octant/domain";
import { readChatThreadView } from "../persistence/chatProjection";
import { readCodeThread } from "../persistence/codeProjection";
import type { SqliteConnection } from "../persistence/sqlitePort";
import type { VisitorThreadRead, VisitorThreadSource } from "./spokeVisitorService";

const MAX_MESSAGES = 200;
const MISSING = { status: "missing" } as const;

type Message = { readonly role: "person" | "agent"; readonly text: string };

function readCode(connection: SqliteConnection, threadId: string): VisitorThreadRead {
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
      ORDER BY start_sequence DESC, content_role DESC
      LIMIT ?
    `)
    .all(threadId, MAX_MESSAGES) as ReadonlyArray<{
    readonly content_role: "user" | "assistant";
    readonly body_text: string;
  }>;
  const messages: Message[] = rows
    .filter((row) => row.body_text.trim() !== "")
    .map(
      (row): Message => ({
        role: row.content_role === "user" ? "person" : "agent",
        text: row.body_text,
      }),
    )
    .reverse();
  const last = messages.at(-1);
  return {
    status: "found",
    title: thread.title,
    archived: thread.lifecycle === "archived",
    state:
      thread.lifecycle === "waiting"
        ? "owner-deciding"
        : last?.role === "person"
          ? "working"
          : "idle",
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
  for (const turn of activeChatTurns(view.turns)) {
    const asked = textOf(String(turn.userMessageRef.contentId), "user");
    if (asked !== undefined) messages.push({ role: "person", text: asked });
    const latest = turn.attempts.at(-1);
    const reply = (latest?.responseRefs ?? [])
      .map((ref) => textOf(String(ref.contentId), "assistant"))
      .filter((text): text is string => text !== undefined)
      .join("");
    if (reply !== "") messages.push({ role: "agent", text: reply });
  }
  const last = messages.at(-1);
  return {
    status: "found",
    title: view.thread.title,
    archived: view.thread.lifecycle === "archived",
    state: last?.role === "person" ? "working" : "idle",
    messages: messages.slice(-MAX_MESSAGES),
  };
}

/** Reads Code and Chat threads from this host's projections. */
export function visitorThreadSource(connection: () => SqliteConnection): VisitorThreadSource {
  return {
    read: (mode, threadId) =>
      mode === "code" ? readCode(connection(), threadId) : readChat(connection(), threadId),
  };
}
