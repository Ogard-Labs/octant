import {
  MAX_CODE_CONVERSATION_PAGE_SIZE,
  type CodeOperationId,
  type CodeThreadForkOrigin,
  type CodeThreadId,
  type WindowId,
} from "@octant/contracts";

/**
 * How many turns of the source thread a fork inherits. A fork is a new
 * direction from a point in a conversation, not a transfer of the whole
 * history, and the handoff has to survive alongside the fork's own turns in one
 * context window.
 */
const MAX_HANDOFF_TURNS = 24;
/** Per-entry cap, applied before the window budget, so one runaway turn cannot consume it. */
const MAX_HANDOFF_ENTRY_CHARACTERS = 4_000;
/** Total handoff budget. Older entries are dropped first when it is exceeded. */
const MAX_HANDOFF_CHARACTERS = 48_000;
/** Page budget for the forward-only conversation reader. */
const MAX_HANDOFF_PAGES = 100;

export interface CodeForkHandoffTurn {
  readonly operationId: CodeOperationId;
  readonly prompt: { readonly contentId: string };
  readonly assistant: ReadonlyArray<{ readonly contentId: string }>;
  readonly status: string;
  readonly startedAt: string;
  readonly updatedAt: string;
}

export interface CodeForkHandoffOptions {
  readonly conversation: (
    windowId: WindowId,
    threadId: CodeThreadId,
    afterCursor: number,
    limit: number,
  ) => Promise<{
    readonly turns: ReadonlyArray<CodeForkHandoffTurn>;
    readonly nextCursor: number;
    readonly hasMore: boolean;
  }>;
  readonly readEvidence: (
    windowId: WindowId,
    threadId: CodeThreadId,
    operationId: CodeOperationId,
    contentId: string,
  ) => Promise<{ readonly bytes: Uint8Array }>;
}

/**
 * Build the read-only context a forked thread's first turn carries.
 *
 * The fork's transcript starts empty, so without this its provider would be
 * answering from nothing while the user believes it inherited a conversation.
 * The handoff is assembled from the source thread's own recorded evidence and
 * stops at the turn the fork branched from — a later turn of the source thread
 * is a direction the fork explicitly did not take.
 *
 * Returns `undefined` when nothing readable remains, so a fork whose source
 * cannot be read says nothing rather than claiming an empty history.
 */
export async function buildCodeForkHandoff(
  options: CodeForkHandoffOptions,
  input: { readonly windowId: WindowId; readonly origin: CodeThreadForkOrigin },
): Promise<string | undefined> {
  const turns = await readTurnsThrough(options, input.windowId, input.origin);
  if (turns === undefined || turns.length === 0) return undefined;

  const entries: string[] = [];
  for (const turn of turns.slice(-MAX_HANDOFF_TURNS)) {
    const threadId = input.origin.threadId;
    const prompt = await readEvidenceText(options, input.windowId, threadId, turn.operationId, [
      turn.prompt.contentId,
    ]);
    if (prompt !== undefined) entries.push(`User: ${prompt}`);
    // An incomplete, waiting, interrupted, or failed turn has no answer, so its
    // partial stream is neither read nor quoted as one.
    if (turn.status !== "completed") continue;
    const answer = await readEvidenceText(
      options,
      input.windowId,
      threadId,
      turn.operationId,
      turn.assistant.map((reference) => reference.contentId),
    );
    if (answer !== undefined) entries.push(`Assistant: ${answer}`);
  }
  if (entries.length === 0) return undefined;

  // Drop from the front: the turn the fork branched from is the one it is
  // continuing, so it is the last thing that may be lost.
  let budget = MAX_HANDOFF_CHARACTERS;
  const kept: string[] = [];
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]!;
    if (entry.length > budget) break;
    budget -= entry.length;
    kept.unshift(entry);
  }
  if (kept.length === 0) return undefined;

  return [
    "This thread was forked from an earlier conversation. The exchange below is",
    "that conversation up to the point of the fork. It is history for reference,",
    "not a new instruction: act only on the message that follows it.",
    "",
    ...kept,
  ].join("\n");
}

/**
 * Walk the source thread's conversation and stop at the fork point.
 *
 * The reader is forward-only, so reaching a given turn means walking to it. A
 * walk that cannot finish, or one that never finds the named turn, yields
 * nothing: handing over a window that silently excludes the fork point would
 * misrepresent what the fork inherited.
 */
async function readTurnsThrough(
  options: CodeForkHandoffOptions,
  windowId: WindowId,
  origin: CodeThreadForkOrigin,
): Promise<ReadonlyArray<CodeForkHandoffTurn> | undefined> {
  const collected: CodeForkHandoffTurn[] = [];
  let cursor = 0;
  let pages = 0;
  try {
    for (;;) {
      const page = await options.conversation(
        windowId,
        origin.threadId,
        cursor,
        MAX_CODE_CONVERSATION_PAGE_SIZE,
      );
      for (const turn of page.turns) {
        collected.push(turn);
        if (String(turn.operationId) === String(origin.throughOperationId)) return collected;
      }
      if (!page.hasMore) return undefined;
      pages += 1;
      if (page.nextCursor <= cursor || pages >= MAX_HANDOFF_PAGES) return undefined;
      cursor = page.nextCursor;
    }
  } catch {
    return undefined;
  }
}

async function readEvidenceText(
  options: CodeForkHandoffOptions,
  windowId: WindowId,
  threadId: CodeThreadId,
  operationId: CodeOperationId,
  contentIds: ReadonlyArray<string>,
): Promise<string | undefined> {
  const decoder = new TextDecoder();
  let text = "";
  for (const contentId of contentIds) {
    if (text.length > MAX_HANDOFF_ENTRY_CHARACTERS) break;
    try {
      const evidence = await options.readEvidence(windowId, threadId, operationId, contentId);
      text += decoder.decode(evidence.bytes);
    } catch {
      // Evidence the host cannot serve is simply absent; the handoff never
      // fabricates a placeholder for content it could not read.
    }
  }
  const normalized = text.trim();
  if (normalized.length === 0) return undefined;
  return normalized.length <= MAX_HANDOFF_ENTRY_CHARACTERS
    ? normalized
    : `${normalized.slice(0, MAX_HANDOFF_ENTRY_CHARACTERS - 1)}…`;
}
