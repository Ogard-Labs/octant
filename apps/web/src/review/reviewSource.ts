import type { ChatClient } from "@octant/client-runtime/chat-client";
import type { CodeClient } from "@octant/client-runtime/code-client";
import type { WorkThreadClient } from "@octant/client-runtime/work-thread-client";
import type { WorkTurnClient } from "@octant/client-runtime/work-turn-client";
import {
  MAX_CODE_CONVERSATION_PAGE_SIZE,
  decodeChatThreadId,
  decodeCodeThreadId,
  decodeWorkThreadId,
  type CodeBoardCard,
  type CodeCheckoutId,
  type CodeConversationTurn,
  type WorkBoardCard,
} from "@octant/contracts";
import { activeChatTurns } from "@octant/domain/chat-policy";
import { observeCodeThreadDiff } from "../code/observeCodeThreadDiff";
import { readConversationEvidence, readConversationText } from "../code/codeControllerState";
import { parseUnifiedDiff, type ParsedDiffFile } from "../code/unifiedDiff";
import type { ReviewCheckKind, ReviewEntry } from "./reviewModel";
import { reviewEntryKey } from "./reviewModel";

/**
 * What the host already knows about a finished thread, one read per mode.
 * A field the host does not report is absent: the page says nothing about a
 * fact it was not told.
 */
export interface ReviewFacts {
  readonly finishedAt?: string;
  readonly changes?: {
    readonly files: number;
    readonly insertions: number;
    readonly deletions: number;
  };
  readonly check: ReviewCheckKind;
  readonly branch?: string;
  readonly base?: string;
  readonly commits?: number;
  /** The checkout a Code thread's diff is read from. */
  readonly checkoutId?: CodeCheckoutId;
  /** Artifacts a Work thread produced, as its board card counts them. */
  readonly artifacts?: number;
}

export interface ReviewReply {
  readonly text: string;
  /** How the last turn ended, so a failed or stopped turn is not read as an answer. */
  readonly outcome: "completed" | "stopped" | "failed";
  /** Paths a Work turn reports it wrote; Code reads its files from the diff instead. */
  readonly wrotePaths?: ReadonlyArray<string>;
}

export interface ReviewOctantCheck {
  readonly verdict: "passed" | "failed" | "running" | "inconclusive";
}

export type ReviewDiff =
  | { readonly status: "ready"; readonly files: ReadonlyArray<ParsedDiffFile>; truncated: boolean }
  | { readonly status: "clean" }
  | { readonly status: "unavailable"; readonly message: string };

export interface ReviewSource {
  readonly loadFacts: (
    entries: ReadonlyArray<ReviewEntry>,
    signal: AbortSignal,
  ) => Promise<ReadonlyMap<string, ReviewFacts>>;
  readonly loadReply: (entry: ReviewEntry, signal: AbortSignal) => Promise<ReviewReply | undefined>;
  /** Code only: the newest repository test result the host still holds. */
  readonly loadOctantCheck?: (
    entry: ReviewEntry,
    facts: ReviewFacts | undefined,
    signal: AbortSignal,
  ) => Promise<ReviewOctantCheck | undefined>;
  /** Code only: what the thread changed. Absent for modes with no checkout. */
  readonly loadDiff?: (
    entry: ReviewEntry,
    facts: ReviewFacts | undefined,
    signal: AbortSignal,
  ) => Promise<ReviewDiff | undefined>;
}

export interface ReviewSourceClients {
  readonly code: CodeClient;
  readonly work: Pick<WorkThreadClient, "queryBoard">;
  readonly workTurns?: Pick<WorkTurnClient, "transcript">;
  readonly chat: Pick<ChatClient, "thread">;
  readonly nextUuid?: () => string;
}

const CHECK_BY_CODE_STATE: Readonly<Record<CodeBoardCard["checks"]["state"], ReviewCheckKind>> = {
  passing: "passed",
  failing: "failing",
  pending: "pending",
  unknown: "none",
};

export function codeReviewFacts(card: CodeBoardCard): ReviewFacts {
  const changed = card.changedFiles;
  return {
    check: CHECK_BY_CODE_STATE[card.checks.state],
    checkoutId: card.checkoutId,
    ...(card.lastMeaningfulActivityAt === null
      ? {}
      : { finishedAt: card.lastMeaningfulActivityAt }),
    ...(changed.kind === "observed"
      ? {
          changes: {
            files: changed.changedPathCount,
            insertions: changed.insertions,
            deletions: changed.deletions,
          },
          commits: changed.committedAhead,
        }
      : {}),
    ...(card.worktree.kind === "available" && card.worktree.head.kind === "branch"
      ? { branch: card.worktree.head.name }
      : {}),
    ...(card.linkedPullRequest.kind === "linked"
      ? { base: card.linkedPullRequest.baseBranch }
      : {}),
  };
}

function workReviewFacts(card: WorkBoardCard): ReviewFacts {
  return {
    check: "none",
    ...(card.lastMeaningfulActivityAt === null
      ? {}
      : { finishedAt: card.lastMeaningfulActivityAt }),
    ...(card.artifacts.count === 0 ? {} : { artifacts: card.artifacts.count }),
  };
}

/**
 * The newest turn of a Code thread, read the way the thread's own transcript
 * reads it, without activating the thread: opening a thread to see its last
 * answer would spend its unread mark.
 */
async function readLastCodeTurn(
  client: CodeClient,
  threadId: ReturnType<typeof decodeCodeThreadId>,
  signal: AbortSignal,
): Promise<CodeConversationTurn | undefined> {
  let cursor = 0;
  let last: CodeConversationTurn | undefined;
  for (let pageIndex = 0; pageIndex < 100; pageIndex += 1) {
    const page = await client.conversation(
      threadId,
      cursor,
      MAX_CODE_CONVERSATION_PAGE_SIZE,
      signal,
    );
    const tail = page.turns.at(-1);
    if (tail !== undefined) last = tail;
    if (!page.hasMore || page.nextCursor <= cursor) break;
    cursor = page.nextCursor;
  }
  return last;
}

async function readCodeReply(
  client: CodeClient,
  entry: ReviewEntry,
  signal: AbortSignal,
): Promise<ReviewReply | undefined> {
  const threadId = decodeCodeThreadId(entry.threadId);
  const turn = await readLastCodeTurn(client, threadId, signal);
  if (turn === undefined) return undefined;
  const evidence = await readConversationEvidence(client, threadId, [turn], signal);
  const parts: string[] = [];
  for (const reference of turn.assistant) {
    const part = await readConversationText(
      client,
      threadId,
      turn.operationId,
      reference.contentId,
      evidence,
      signal,
    );
    if (part !== undefined) parts.push(part);
  }
  const text = parts.join("").trim();
  return {
    text: text === "" ? (turn.failure?.message ?? "") : text,
    outcome:
      turn.status === "completed" ? "completed" : turn.status === "failed" ? "failed" : "stopped",
  };
}

async function readChatReply(
  client: Pick<ChatClient, "thread">,
  entry: ReviewEntry,
): Promise<ReviewReply | undefined> {
  const view = await client.thread(decodeChatThreadId(entry.threadId));
  const contentById = new Map(view.contents.map((content) => [String(content.contentId), content]));
  const attempt = activeChatTurns(view.turns).at(-1)?.attempts.at(-1);
  if (attempt === undefined) return undefined;
  const text = attempt.responseRefs
    .map((reference) => contentById.get(String(reference.contentId))?.body ?? "")
    .join("")
    .trim();
  return {
    text,
    outcome:
      attempt.outcome === "completed"
        ? "completed"
        : attempt.outcome === "failed"
          ? "failed"
          : "stopped",
  };
}

async function readWorkReply(
  client: Pick<WorkTurnClient, "transcript">,
  entry: ReviewEntry,
  signal: AbortSignal,
): Promise<ReviewReply | undefined> {
  const transcript = await client.transcript(decodeWorkThreadId(entry.threadId), signal);
  const turn = transcript.turns.at(-1);
  if (turn === undefined) return undefined;
  return {
    text: (turn.response ?? turn.failure?.message ?? "").trim(),
    outcome:
      turn.status === "completed" ? "completed" : turn.status === "failed" ? "failed" : "stopped",
    ...(turn.wroteFiles === undefined || turn.wroteFiles.paths.length === 0
      ? {}
      : { wrotePaths: turn.wroteFiles.paths }),
  };
}

export function createReviewSource(clients: ReviewSourceClients): ReviewSource {
  const nextUuid = clients.nextUuid ?? (() => globalThis.crypto.randomUUID());
  // When each Code thread's last turn ended. The board's own activity time moves
  // whenever anything touches the thread, including this page reading its diff,
  // so a thread whose changes had been looked at would read "just now" and sort
  // last. The turn's own end does not move until the thread runs again, and a
  // thread that runs leaves the list and drops out of this cache with it.
  const turnEndedAt = new Map<string, string>();
  return {
    async loadFacts(entries, signal) {
      const facts = new Map<string, ReviewFacts>();
      const wanted = (mode: ReviewEntry["mode"]) =>
        new Set(entries.filter((entry) => entry.mode === mode).map((entry) => entry.threadId));
      const codeIds = wanted("code");
      const workIds = wanted("work");
      for (const known of turnEndedAt.keys()) {
        if (!codeIds.has(known)) turnEndedAt.delete(known);
      }
      // One mode's board failing leaves the other's facts in place; a row with
      // no facts still lists, it just says less.
      const [code, work] = await Promise.allSettled([
        codeIds.size === 0 ? undefined : clients.code.queryBoard({ version: 1 }),
        workIds.size === 0 ? undefined : clients.work.queryBoard({ version: 1 }),
        ...[...codeIds]
          .filter((threadId) => !turnEndedAt.has(threadId))
          .map(async (threadId) => {
            const turn = await readLastCodeTurn(clients.code, decodeCodeThreadId(threadId), signal);
            if (turn !== undefined) turnEndedAt.set(threadId, String(turn.updatedAt));
          }),
      ]);
      if (code.status === "fulfilled" && code.value !== undefined) {
        for (const card of code.value.cards) {
          const threadId = String(card.threadId);
          if (codeIds.has(threadId)) {
            const ended = turnEndedAt.get(threadId);
            facts.set(reviewEntryKey({ mode: "code", threadId }), {
              ...codeReviewFacts(card),
              ...(ended === undefined ? {} : { finishedAt: ended }),
            });
          }
        }
      }
      if (work.status === "fulfilled" && work.value !== undefined) {
        for (const card of work.value.cards) {
          if (workIds.has(String(card.threadId))) {
            facts.set(
              reviewEntryKey({ mode: "work", threadId: String(card.threadId) }),
              workReviewFacts(card),
            );
          }
        }
      }
      return facts;
    },
    async loadReply(entry, signal) {
      if (entry.mode === "code") return await readCodeReply(clients.code, entry, signal);
      if (entry.mode === "chat") return await readChatReply(clients.chat, entry);
      if (clients.workTurns === undefined) return undefined;
      return await readWorkReply(clients.workTurns, entry, signal);
    },
    async loadOctantCheck(entry, facts) {
      if (entry.mode !== "code" || facts?.checkoutId === undefined) return undefined;
      const read = clients.code.readTestStatus?.bind(clients.code);
      if (read === undefined) return undefined;
      const status = await read(decodeCodeThreadId(entry.threadId), facts.checkoutId);
      const result = status.result;
      if (result === undefined) return undefined;
      if (result.state === "running") return { verdict: "running" };
      if (result.state === "completed") {
        if (result.verdict === "passed") return { verdict: "passed" };
        if (result.verdict === "failed") return { verdict: "failed" };
        return { verdict: "inconclusive" };
      }
      return { verdict: result.state === "failed" ? "failed" : "inconclusive" };
    },
    async loadDiff(entry, facts, signal) {
      if (entry.mode !== "code" || facts?.checkoutId === undefined) return undefined;
      const threadId = decodeCodeThreadId(entry.threadId);
      const projection = await observeCodeThreadDiff(clients.code, nextUuid, {
        checkoutId: facts.checkoutId,
        threadId,
      });
      if (projection.state === "unavailable" || projection.state === "stale") {
        return { status: "unavailable", message: projection.message };
      }
      if (projection.state === "loading") return undefined;
      const [operationId, changedPaths, evidence] =
        projection.state === "run"
          ? [
              projection.run.operationId,
              projection.run.outcome.changedPaths,
              projection.run.outcome.diff,
            ]
          : [
              projection.observation.operationId,
              projection.observation.changedPaths,
              projection.observation.diff,
            ];
      if (changedPaths.length === 0) return { status: "clean" };
      try {
        const bytes = await clients.code.operationContent(
          threadId,
          operationId,
          evidence.contentId,
          signal,
        );
        const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        return {
          status: "ready",
          files: parseUnifiedDiff(text),
          truncated: evidence.truncated === true,
        };
      } catch (error) {
        if (signal.aborted) throw error;
        return { status: "unavailable", message: "The diff could not be read from the host." };
      }
    },
  };
}
