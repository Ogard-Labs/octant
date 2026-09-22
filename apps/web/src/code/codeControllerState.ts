import type { CodeClient } from "@octant/client-runtime/code-client";
import type {
  CodeBootstrap,
  CodeCommand,
  CodeCommandResult,
  CodeEventFrame,
  CodeFailure,
  CodeThread,
  CodeThreadId,
  CodeThreadView,
} from "@octant/contracts/code";
import {
  MAX_CODE_EVIDENCE_BATCH_ITEMS,
  type CodeConversationTurn,
  type CodeEvidenceContentId,
  type CodeOperationEvent,
  type CodeOperationId,
  type CodeAttachmentReference,
  type CodeApprovalId,
  type CodeCheckpoint,
  type CodeTurnChangedFiles,
  type ProviderExecutionPolicy,
} from "@octant/contracts";
import {
  appendReasoning,
  applyActivityEvent,
  EMPTY_TURN_ACTIVITY,
  type CodeTurnActivity,
} from "./transcriptActivity";
import { samePollingData } from "../polling/samePollingData";
import { createReadCursorStore, type ReadCursorStore } from "../threads/readCursorStore";

export type CodeProviderRequest =
  | {
      readonly kind: "approval";
      readonly approvalId: CodeApprovalId;
      readonly summary: string;
    }
  | {
      readonly kind: "input";
      readonly requestId: string;
      readonly prompt: string;
      readonly options: ReadonlyArray<string>;
    };

export interface CodeConversationMessage {
  readonly id: string;
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly operationId?: CodeOperationId;
  readonly sourceThreadId?: CodeThreadId;
  readonly providerInstanceId?: CodeThread["providerInstanceId"];
  readonly modelId?: CodeThread["modelId"];
  readonly status?: "waiting" | "completed" | "interrupted" | "failed" | "incomplete";
  /**
   * When this message happened, as the journal recorded its turn: the turn's
   * start for the prompt, its last update for the reply. Absent on a message
   * still being composed locally, which has not been journaled yet.
   */
  readonly at?: string;
  /** Images this message carried, as the turn's start event recorded them. */
  readonly attachments?: ReadonlyArray<CodeAttachmentReference>;
  /**
   * The checkout as it stood before this turn ran. Present on a user message
   * whose turn the host managed to checkpoint, and what the transcript's
   * restore control acts on.
   */
  readonly checkpoint?: CodeCheckpoint;
  /**
   * The posture this turn ran under, as the host recorded it. Absent on a
   * message whose turn was journaled before the host started recording it.
   */
  readonly executionPolicy?: ProviderExecutionPolicy;
  /**
   * What changed in the checkout while this turn ran. Present on an assistant
   * message whose turn the host observed; absent means "not observed", which
   * is not the same as "nothing changed".
   */
  readonly changedFiles?: CodeTurnChangedFiles;
}

function providerRequestFromEvent(event: CodeOperationEvent): CodeProviderRequest | undefined {
  if (event.kind === "approval-requested") {
    return { kind: "approval", approvalId: event.approvalId, summary: event.summary };
  }
  if (event.kind === "input-requested") {
    return {
      kind: "input",
      requestId: event.requestId,
      prompt: event.prompt,
      options: event.options,
    };
  }
  return undefined;
}

export function refreshActiveThreadView(
  current: CodeThreadView | undefined,
  next: CodeBootstrap,
): CodeThreadView | undefined {
  if (current === undefined) return current;
  const checkout = next.checkouts.find(
    (candidate) => String(candidate.id) === String(current.checkout.id),
  );
  const refreshedThread = next.threads.find(
    (candidate) => String(candidate.id) === String(current.thread.id),
  );
  if (checkout === undefined && refreshedThread === undefined) return current;
  if (
    (checkout === undefined || samePollingData(checkout, current.checkout)) &&
    (refreshedThread === undefined || samePollingData(refreshedThread, current.thread))
  ) {
    return current;
  }
  return {
    ...current,
    ...(checkout === undefined ? {} : { checkout }),
    ...(refreshedThread === undefined ? {} : { thread: refreshedThread }),
  };
}

/** Code keeps its own record, so Chat's cursors never read as Code's. */
const CODE_READ_CURSOR_STORAGE_KEY = "octant.code.readCursors.v1";

/**
 * Code's read cursors.
 *
 * The sequence is the host's, from the bootstrap: a thread's own version cannot
 * stand in for it, because a provider turn is journaled on a different
 * aggregate and moves neither the version nor `updatedAt`.
 *
 * The store itself is shared with Chat — unread is the same idea in both modes
 * — and survives a relaunch, so a thread the user read yesterday does not come
 * back unread today.
 */
export type CodeReadCursorStore = ReadCursorStore<CodeThreadId>;

export function createCodeReadCursorStore(
  storage?: Pick<Storage, "getItem" | "setItem"> | undefined,
): CodeReadCursorStore {
  return createReadCursorStore<CodeThreadId>({
    storageKey: CODE_READ_CURSOR_STORAGE_KEY,
    ...(storage === undefined ? {} : { storage }),
  });
}

/**
 * What a Code thread has consumed, and the provider usage windows it last
 * heard about. Every figure comes from the provider: a provider that reports
 * no cost leaves `costUsd` absent rather than showing a derived number.
 */
export interface CodeCacheCoverage {
  /** Coverage is over turns with usage reports, not all conversation turns. */
  readonly reportedTurns: number;
  readonly read: { readonly measuredTurns: number; readonly measuredTokens: number };
  readonly write: { readonly measuredTurns: number; readonly measuredTokens: number };
}

export interface CodeTurnUsage {
  readonly inputTokens: number;
  readonly cacheReadInputTokens?: number | undefined;
  readonly cacheWriteInputTokens?: number | undefined;
  readonly outputTokens: number;
  readonly costUsd?: number | undefined;
  readonly contextWindow?: number | undefined;
  readonly contextTokens?: number | undefined;
}

/**
 * Add up what each turn reported.
 *
 * The thread's figure is the sum over turns, never the sum over reports: a
 * provider may report a turn's usage repeatedly as it runs, and each report is
 * that turn's total so far, not an amount to add to the one before it. Keeping
 * a figure per turn is what makes the live number agree with the one the
 * journal projects when the thread is reopened.
 */
export function totalTurnUsage(byOperation: ReadonlyMap<string, CodeTurnUsage>): {
  readonly cacheCoverage?: CodeCacheCoverage;
  readonly inputTokens?: number;
  readonly cacheReadInputTokens?: number;
  readonly cacheWriteInputTokens?: number;
  readonly outputTokens?: number;
  readonly costUsd?: number;
  readonly contextWindow?: number;
  readonly contextTokens?: number;
} {
  if (byOperation.size === 0) return {};
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadInputTokens: number | undefined;
  let cacheReadTurns = 0;
  let cacheWriteTurns = 0;
  let cacheWriteInputTokens: number | undefined;
  let costUsd: number | undefined;
  let contextWindow: number | undefined;
  let contextTokens: number | undefined;
  for (const usage of byOperation.values()) {
    inputTokens += usage.inputTokens;
    outputTokens += usage.outputTokens;
    if (usage.cacheReadInputTokens !== undefined) {
      cacheReadTurns += 1;
      cacheReadInputTokens = (cacheReadInputTokens ?? 0) + usage.cacheReadInputTokens;
    }
    if (usage.cacheWriteInputTokens !== undefined) {
      cacheWriteTurns += 1;
      cacheWriteInputTokens = (cacheWriteInputTokens ?? 0) + usage.cacheWriteInputTokens;
    }
    if (usage.costUsd !== undefined) costUsd = (costUsd ?? 0) + usage.costUsd;
    if (usage.contextWindow !== undefined) contextWindow = usage.contextWindow;
    if (usage.contextTokens !== undefined) contextTokens = usage.contextTokens;
  }
  return {
    inputTokens,
    outputTokens,
    ...(costUsd === undefined ? {} : { costUsd }),
    ...(cacheReadTurns !== byOperation.size || cacheReadInputTokens === undefined
      ? {}
      : { cacheReadInputTokens }),
    ...(cacheWriteTurns !== byOperation.size || cacheWriteInputTokens === undefined
      ? {}
      : { cacheWriteInputTokens }),
    cacheCoverage: {
      reportedTurns: byOperation.size,
      read: { measuredTurns: cacheReadTurns, measuredTokens: cacheReadInputTokens ?? 0 },
      write: { measuredTurns: cacheWriteTurns, measuredTokens: cacheWriteInputTokens ?? 0 },
    },
    ...(contextWindow === undefined ? {} : { contextWindow }),
    ...(contextTokens === undefined ? {} : { contextTokens }),
  };
}

export function conversationFallback(
  status: "waiting" | "completed" | "interrupted" | "failed" | "incomplete",
): string {
  switch (status) {
    case "waiting":
      return "The provider turn is waiting for input or recovery.";
    case "interrupted":
      return "The provider turn was interrupted.";
    case "failed":
      return "The provider turn failed.";
    case "incomplete":
      return "Working…";
    case "completed":
      return "The provider turn finished without a visible reply.";
  }
}

/** Whether a refused bootstrap describes a host that may simply not be up yet. */
export function worthAskingAgain(error: unknown): boolean {
  const category = codeFailure(error).category;
  return category === "disconnected" || category === "unavailable";
}

export function codeFailure(error: unknown): Pick<CodeFailure, "category" | "message"> {
  if (
    typeof error === "object" &&
    error !== null &&
    "category" in error &&
    typeof error.category === "string" &&
    "message" in error &&
    typeof error.message === "string"
  ) {
    return { category: error.category as CodeFailure["category"], message: error.message };
  }
  return { category: "disconnected", message: "The local Octant Code service is unavailable." };
}

export function replaceById<T extends { readonly id: unknown }>(
  items: ReadonlyArray<T>,
  value: T,
): T[] {
  const index = items.findIndex((candidate) => candidate.id === value.id);
  if (index === -1) return [...items, value];
  return items.map((candidate, candidateIndex) => (candidateIndex === index ? value : candidate));
}

export function applyEvent(current: CodeBootstrap | undefined, frame: CodeEventFrame) {
  return current === undefined ? current : applyResult(current, frame.event);
}

export function applyResult(current: CodeBootstrap | undefined, result: CodeCommandResult) {
  if (current === undefined) return current;
  switch (result.kind) {
    case "checkout-prepared":
      return { ...current, checkouts: replaceById(current.checkouts, result.checkout) };
    case "settings-updated":
      return { ...current, settings: result.settings };
    case "thread-created":
    case "thread-updated":
      return { ...current, threads: replaceById(current.threads, result.thread) };
    case "thread-lifecycle-changed":
      return {
        ...current,
        threads: current.threads.map((thread) =>
          thread.id === result.threadId
            ? { ...thread, lifecycle: result.lifecycle, version: result.version }
            : thread,
        ),
      };
    case "worktree-source-previewed":
    case "worktree-remote-facts-retrieved":
    case "worktree-refs-listed":
      return current;
    case "thread-checkout-rebind":
      return result.outcome.status === "refused"
        ? current
        : {
            ...current,
            threads: replaceById(current.threads, result.outcome.thread),
            checkouts: replaceById(current.checkouts, result.outcome.checkout),
          };
    case "managed-thread-created":
      return {
        ...current,
        threads: replaceById(current.threads, result.thread),
        checkouts: replaceById(current.checkouts, result.checkout),
      };
    default:
      // A result this reducer does not name says nothing about bootstrap
      // state, so it leaves it alone. Falling out of the switch returned
      // `undefined` instead, which erased everything Code had loaded — while
      // `status` stayed "ready", so the renderer reported a healthy Code
      // surface that then refused every thread. A host one version ahead can
      // answer with a kind this renderer has never heard of, so the safe
      // answer has to be the runtime one, not an exhaustiveness assertion.
      return current;
  }
}

export function commandTargets(command: CodeCommand, threadId: CodeThreadId): boolean {
  return "threadId" in command && command.threadId === threadId;
}

export function acceptFrame(
  frame: CodeEventFrame,
  threadId: CodeThreadId,
  cursor: number,
): boolean {
  return frame.threadId === threadId && Number(frame.sequence) === cursor + 1;
}

export function isActive(
  request: number,
  generation: { readonly current: number },
  mounted: { readonly current: boolean },
): boolean {
  return mounted.current && request === generation.current;
}

async function readOperationText(
  client: CodeClient,
  threadId: CodeThreadId,
  operationId: CodeOperationId,
  contentId: CodeEvidenceContentId,
  signal?: AbortSignal,
): Promise<string | undefined> {
  try {
    const bytes = await client.operationContent(threadId, operationId, contentId, signal);
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

async function readForkConversation(
  client: CodeClient,
  origin: NonNullable<CodeThread["forkedFrom"]>,
  signal: AbortSignal,
  visited: ReadonlySet<string> = new Set(),
): Promise<{
  readonly messages: ReadonlyArray<CodeConversationMessage>;
  readonly activity: ReadonlyMap<string, CodeTurnActivity>;
}> {
  const sourceId = String(origin.threadId);
  if (visited.has(sourceId) || visited.size >= 32)
    throw new Error("Fork history contains an invalid lineage.");
  const source = await client.thread(origin.threadId, signal);
  const inherited =
    source.thread.forkedFrom === undefined
      ? { messages: [], activity: new Map<string, CodeTurnActivity>() }
      : await readForkConversation(
          client,
          source.thread.forkedFrom,
          signal,
          new Set([...visited, sourceId]),
        );
  const messages: CodeConversationMessage[] = [...inherited.messages];
  const activity = new Map(inherited.activity);
  let cursor = 0;
  for (let pageIndex = 0; pageIndex < 100; pageIndex += 1) {
    const page = await client.conversation(origin.threadId, cursor, 50, signal);
    const boundary = page.turns.findIndex(
      (turn) => String(turn.operationId) === String(origin.throughOperationId),
    );
    const turns = boundary < 0 ? page.turns : page.turns.slice(0, boundary + 1);
    const evidence = await readConversationEvidence(client, origin.threadId, turns, signal);
    const projected = await projectConversationTurns(
      client,
      origin.threadId,
      turns,
      evidence,
      signal,
    );
    messages.push(
      ...projected.messages.map((message) => ({ ...message, sourceThreadId: origin.threadId })),
    );
    for (const [key, value] of projected.activity) activity.set(key, value);
    if (boundary >= 0) return { messages, activity };
    if (!page.hasMore || page.nextCursor <= cursor) break;
    cursor = page.nextCursor;
  }
  throw new Error("The source response for this fork is unavailable.");
}

async function projectConversationTurns(
  client: CodeClient,
  threadId: CodeThreadId,
  turns: ReadonlyArray<CodeConversationTurn>,
  evidence: ReadonlyMap<string, string> | undefined,
  signal: AbortSignal,
): Promise<{
  readonly messages: ReadonlyArray<CodeConversationMessage>;
  readonly activity: ReadonlyMap<string, CodeTurnActivity>;
}> {
  const messages: CodeConversationMessage[] = [];
  const activity = new Map<string, CodeTurnActivity>();
  for (const turn of turns) {
    if (signal.aborted) throw new DOMException("The request was aborted.", "AbortError");
    const prompt = await readConversationText(
      client,
      threadId,
      turn.operationId,
      turn.prompt.contentId,
      evidence,
      signal,
    );
    messages.push({
      id: `${turn.operationId}:user`,
      role: "user",
      text: prompt ?? "Conversation prompt evidence is unavailable.",
      operationId: turn.operationId,
      providerInstanceId: turn.providerInstanceId,
      modelId: turn.modelId,
      status: turn.status,
      at: String(turn.startedAt),
      ...(turn.attachments === undefined || turn.attachments.length === 0
        ? {}
        : { attachments: turn.attachments }),
      ...(turn.checkpoint === undefined ? {} : { checkpoint: turn.checkpoint }),
      ...(turn.executionPolicy === undefined ? {} : { executionPolicy: turn.executionPolicy }),
    });
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
    messages.push({
      id: `${turn.operationId}:assistant`,
      role: "assistant",
      text: parts.join("") || turn.failure?.message || conversationFallback(turn.status),
      operationId: turn.operationId,
      providerInstanceId: turn.providerInstanceId,
      modelId: turn.modelId,
      status: turn.status,
      at: String(turn.updatedAt),
      ...(turn.changedFiles === undefined ? {} : { changedFiles: turn.changedFiles }),
    });
    const steps = turn.steps ?? [];
    if (steps.length === 0 && turn.stepsTruncated !== true) continue;
    let replayed = EMPTY_TURN_ACTIVITY;
    for (const step of steps) {
      if (step.kind === "tool") {
        replayed = applyActivityEvent(replayed, {
          kind: "tool-activity",
          toolCallId: step.toolCallId,
          toolName: step.toolName,
          state: step.state,
          ...(step.summary === undefined ? {} : { summary: step.summary }),
        });
        continue;
      }
      const text = await readConversationText(
        client,
        threadId,
        turn.operationId,
        step.content.contentId,
        evidence,
        signal,
      );
      if (text !== undefined) replayed = appendReasoning(replayed, text);
    }
    activity.set(String(turn.operationId), {
      ...replayed,
      ...(turn.stepsTruncated === true ? { truncated: true } : {}),
    });
  }
  return { messages, activity };
}

async function readConversationEvidence(
  client: CodeClient,
  threadId: CodeThreadId,
  turns: ReadonlyArray<CodeConversationTurn>,
  signal: AbortSignal,
): Promise<ReadonlyMap<string, string> | undefined> {
  const read = client.operationContents;
  if (read === undefined) return undefined;
  const unique = new Map<
    string,
    { readonly operationId: CodeOperationId; readonly contentId: CodeEvidenceContentId }
  >();
  for (const turn of turns) {
    const references = [
      turn.prompt,
      ...turn.assistant,
      ...(turn.steps ?? []).flatMap((step) => (step.kind === "reasoning" ? [step.content] : [])),
    ];
    for (const reference of references) {
      const key = `${String(turn.operationId)}:${String(reference.contentId)}`;
      unique.set(key, { operationId: turn.operationId, contentId: reference.contentId });
    }
  }
  const items = [...unique.values()];
  let responses: ReadonlyArray<Awaited<ReturnType<NonNullable<CodeClient["operationContents"]>>>>;
  try {
    responses = await Promise.all(
      Array.from({ length: Math.ceil(items.length / MAX_CODE_EVIDENCE_BATCH_ITEMS) }, (_, index) =>
        read(
          {
            threadId,
            items: items.slice(
              index * MAX_CODE_EVIDENCE_BATCH_ITEMS,
              (index + 1) * MAX_CODE_EVIDENCE_BATCH_ITEMS,
            ),
          },
          signal,
        ),
      ),
    );
  } catch (error) {
    if (signal.aborted) throw error;
    // A renderer may reconnect to a host from before the batch endpoint was
    // introduced. Preserve transcript recovery through the existing bounded
    // per-reference reads instead of treating that host as corrupt.
    return undefined;
  }
  const text = new Map<string, string>();
  for (const response of responses) {
    if (String(response.threadId) !== String(threadId)) continue;
    for (const item of response.items) {
      text.set(`${String(item.operationId)}:${String(item.contentId)}`, item.text);
    }
  }
  return text;
}

async function readConversationText(
  client: CodeClient,
  threadId: CodeThreadId,
  operationId: CodeOperationId,
  contentId: CodeEvidenceContentId,
  evidence: ReadonlyMap<string, string> | undefined,
  signal?: AbortSignal,
): Promise<string | undefined> {
  if (evidence !== undefined) {
    const text = evidence.get(`${String(operationId)}:${String(contentId)}`);
    if (text !== undefined) return text;
  }
  return readOperationText(client, threadId, operationId, contentId, signal);
}

export {
  providerRequestFromEvent,
  readForkConversation,
  readOperationText,
  readConversationEvidence,
  readConversationText,
  projectConversationTurns,
};
