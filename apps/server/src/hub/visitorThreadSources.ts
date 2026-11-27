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
  type CodeRuntimeWorkState,
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

/** A scheme word whose value is the part still being written. */
const TRAILING_SCHEME = /\b(?:bearer|basic)\s+$/i;

/**
 * A streaming reply up to its last whitespace. The visitor read redacts by a
 * secret's shape, which the first characters of one still being written do not
 * have yet, so a word is shown only once the reply has moved past it. A
 * `Bearer` or `Basic` just before that word is held back with it, so the
 * redactor never reads the scheme as the whole of a credential.
 */
function finishedWords(live: string): string {
  return (/^[\s\S]*\s/.exec(live)?.[0] ?? "").replace(TRAILING_SCHEME, "");
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
            { role: "assistant" as const, text: finishedWords(live) },
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
  // Each row carries its turn's work state: the turn runs under the operation
  // whose id names that record.
  const rows = connection
    .prepare(`
      SELECT search.content_role, search.body_text, work.state AS turn_state
      FROM code_transcript_search_projection AS search
      LEFT JOIN code_runtime_projection AS work
        ON work.runtime_work_id = search.operation_id
        AND work.thread_id = search.thread_id
        AND work.work_kind = 'provider-turn'
      WHERE search.thread_id = ? AND search.rewound = 0
      ORDER BY search.start_sequence DESC, search.content_role ASC
      LIMIT ?
    `)
    .all(threadId, MAX_MESSAGES) as ReadonlyArray<{
    readonly content_role: "user" | "assistant";
    readonly body_text: string;
    readonly turn_state: CodeRuntimeWorkState | null;
  }>;
  const turnActivity = activity(id);
  const running = turnActivity.executing === true || turnActivity.awaitingInput === true;
  // Newest first, so the newest turn's reply row comes first.
  const newest = rows.find((row) => row.content_role === "assistant");
  // Only a reply whose turn completed is shown whole. The newest one must say
  // so: a turn parked or waiting reports neither executing nor a question. An
  // older one without a record has nothing left to write it.
  const unfinished = (row: (typeof rows)[number]) =>
    row.content_role === "assistant" &&
    (row === newest
      ? running || row.turn_state !== "completed"
      : row.turn_state !== null && row.turn_state !== "completed");
  // A completed turn's prompt and reply share a sequence. Newest first, the
  // reply comes before its prompt here, so the reversal below puts the prompt first.
  const messages: Message[] = rows
    .map(
      (row): Message => ({
        role: row.content_role === "user" ? "person" : "agent",
        text: unfinished(row) ? finishedWords(row.body_text) : row.body_text,
      }),
    )
    .filter((message) => message.text.trim() !== "")
    .reverse();
  return {
    status: "found",
    title: thread.title,
    archived: thread.lifecycle === "archived",
    state: codeVisitorState(thread.lifecycle, turnActivity),
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
  const lastAttempt = turns.at(-1)?.attempts.at(-1);
  const lastAttemptId = lastAttempt === undefined ? undefined : String(lastAttempt.id);
  const lastStopReleased = parkedStopReleased(view.thread, lastAttemptId);
  for (const turn of turns) {
    const asked = textOf(String(turn.userMessageRef.contentId), "user");
    if (asked !== undefined) messages.push({ role: "person", text: asked });
    const latest = turn.attempts.at(-1);
    const reply = (latest?.responseRefs ?? [])
      .map((ref) => textOf(String(ref.contentId), "assistant"))
      .filter((text): text is string => text !== undefined)
      .join("");
    // Only a reply that completed is shown whole. One still being written,
    // or one that stopped for good (interrupted, failed, or a usage-limit
    // stop a newer turn or an account move left behind), may end inside a
    // credential the redactor cannot recognise yet, so its last unfinished
    // word stays back: a visitor may miss one word, never part of a secret.
    const unfinished = latest !== undefined && latest.outcome !== "completed";
    const shown = unfinished ? finishedWords(reply) : reply;
    if (shown.trim() !== "") messages.push({ role: "agent", text: shown });
  }
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
      lastStopReleased,
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
