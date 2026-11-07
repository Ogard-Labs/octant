import {
  decodeCodeCommand,
  decodeThreadMessageQueueCommand,
  decodeThreadMessageQueueScope,
  decodeWindowId,
  type CodeCommand,
  type CodeCommandResult,
  type OctantMode,
  type SideTaskOffer,
  type ThreadMessageQueueRefusalReason,
  type WindowId,
  type WorkThreadCommandResult,
} from "@octant/contracts";
import type { ThreadMessageQueueService } from "../messageQueue/threadMessageQueueService";
import type {
  OfferingTurnStanding,
  SideTaskForkOutcome,
  SideTaskHereOutcome,
  SideTaskTurnInput,
} from "./sideTaskStart";

/** The turns each mode's fork reads, narrowed to what a fork point needs. */
export interface SideTaskTurnReaders {
  readonly chatTurns: (threadId: string) =>
    | ReadonlyArray<{
        readonly id: string;
        readonly attempts: ReadonlyArray<{ readonly outcome: string }>;
      }>
    | undefined;
  readonly workTurns: (threadId: string) => ReadonlyArray<{
    readonly turnId: string;
    readonly requestId: string;
    readonly status: string;
  }>;
  /** Undefined when the history is longer than a fork reads. */
  readonly codeTurns: (
    threadId: string,
  ) => ReadonlyArray<{ readonly operationId: string; readonly status: string }> | undefined;
}

export interface SideTaskForkPorts extends SideTaskTurnReaders {
  readonly chat: {
    readonly readThread: (threadId: string) => { readonly version: number } | undefined;
    readonly execute: (
      command: unknown,
      context: { readonly windowId: WindowId },
    ) => Promise<unknown>;
  };
  readonly work: {
    readonly execute: (
      windowId: WindowId,
      command: unknown,
    ) => Promise<WorkThreadCommandResult> | WorkThreadCommandResult;
  };
  readonly code:
    | {
        readonly execute: (
          windowId: WindowId,
          command: CodeCommand,
        ) => Promise<CodeCommandResult> | CodeCommandResult;
      }
    | undefined;
  readonly uuid: () => string;
}

const CHAT_IN_FLIGHT = new Set(["queued", "streaming"]);
const WORK_ACTIVE = new Set(["accepted", "running", "waiting"]);
/** A Code turn without a result reads as incomplete; one parked on an approval as waiting. */
const CODE_ACTIVE = new Set(["incomplete", "waiting"]);

/**
 * Whether a fork through the offering turn could be taken now, by the rule
 * each mode's fork applies: a Chat branch waits for every reply in the
 * thread, a Work fork for every turn it would carry, and a Code fork for the
 * named operation. A Code history too long to read is left to the fork's own
 * refusal.
 */
export function offeringTurnStanding(
  readers: SideTaskTurnReaders,
  input: { readonly mode: OctantMode; readonly threadId: string; readonly turnId: string },
): OfferingTurnStanding {
  if (input.mode === "chat") {
    const turns = readers.chatTurns(input.threadId) ?? [];
    const offering = turns.find((turn) => String(turn.id) === input.turnId);
    if (offering === undefined) return "not-found";
    const inFlight = turns.some((turn) =>
      turn.attempts.some((attempt) => CHAT_IN_FLIGHT.has(attempt.outcome)),
    );
    const waiting = offering.attempts.at(-1)?.outcome === "waiting";
    return inFlight || waiting ? "running" : "settled";
  }
  if (input.mode === "work") {
    const turns = readers.workTurns(input.threadId);
    const through = turns.findIndex((turn) => String(turn.turnId) === input.turnId);
    if (through === -1) return "not-found";
    return turns.slice(0, through + 1).some((turn) => WORK_ACTIVE.has(turn.status))
      ? "running"
      : "settled";
  }
  const turns = readers.codeTurns(input.threadId);
  if (turns === undefined) return "settled";
  const offering = turns.find((turn) => String(turn.operationId) === input.turnId);
  if (offering === undefined) return "not-found";
  return CODE_ACTIVE.has(offering.status) ? "running" : "settled";
}

/**
 * Forks the offering thread through the offering turn with the mode's own
 * command, so the fork's rules (its handoff, marks, and refusals) apply
 * unchanged: `branch-chat-thread`, `fork-work-thread`, or `fork-code-thread`
 * (always its own worktree). Every fork is created on the source's provider
 * and model; the prompt is sent only when that is still the model that made
 * the offer.
 */
export async function forkThroughOfferingTurn(
  ports: SideTaskForkPorts,
  input: { readonly windowId: string; readonly offer: SideTaskOffer; readonly turnId: string },
): Promise<SideTaskForkOutcome> {
  const { offer, turnId } = input;
  const sourceThreadId = String(offer.threadId);
  const onOfferingModel = (thread: {
    readonly providerInstanceId: string;
    readonly modelId: string;
  }) =>
    String(thread.providerInstanceId) === String(offer.suggestedBy.providerInstanceId) &&
    String(thread.modelId) === String(offer.suggestedBy.modelId);
  try {
    const windowId = decodeWindowId(input.windowId);
    if (offer.mode === "chat") {
      const source = ports.chat.readThread(sourceThreadId);
      if (source === undefined) return refused("The Chat thread this offer came from is gone.");
      const result = await ports.chat.execute(
        {
          kind: "branch-chat-thread",
          threadId: sourceThreadId,
          expectedVersion: source.version,
          turnId,
          title: offer.title,
          branchThreadId: ports.uuid(),
        },
        { windowId },
      );
      const branch = createdThread(result);
      if (branch === undefined) return refused("The host did not branch the Chat thread.");
      return forked("chat", branch.id, onOfferingModel(branch));
    }
    if (offer.mode === "work") {
      const through = ports
        .workTurns(sourceThreadId)
        .find((turn) => String(turn.turnId) === turnId);
      if (through === undefined) return refused("The turn this offer came from is gone.");
      const result = await ports.work.execute(windowId, {
        kind: "fork-work-thread",
        threadId: ports.uuid(),
        sourceThreadId,
        throughRequestId: through.requestId,
        title: offer.title,
      });
      if (!("kind" in result) || result.kind !== "thread-created") {
        return refused("message" in result ? result.message : "The host did not fork the thread.");
      }
      return forked("work", result.thread.id, onOfferingModel(result.thread));
    }
    if (ports.code === undefined) return refused("Code is unavailable on this host.");
    const result = await ports.code.execute(
      windowId,
      decodeCodeCommand({
        kind: "fork-code-thread",
        threadId: ports.uuid(),
        sourceThreadId,
        throughOperationId: turnId,
        title: offer.title,
      }),
    );
    if (result.kind !== "managed-thread-created") {
      return refused("The host did not fork the Code thread.");
    }
    return forked("code", result.thread.id, onOfferingModel(result.thread));
  } catch (error) {
    // A service refusal carries a sentence worth showing; a schema dump does not.
    const message = error instanceof Error ? error.message : "";
    return refused(
      message.length > 0 && message.length <= 240 ? message : "The fork could not be created.",
    );
  }
}

/** The thread a Chat command created, read without trusting the result's shape. */
function createdThread(
  result: unknown,
):
  | { readonly id: string; readonly providerInstanceId: string; readonly modelId: string }
  | undefined {
  if (typeof result !== "object" || result === null) return undefined;
  if (!("kind" in result) || result.kind !== "thread-created") return undefined;
  if (!("thread" in result) || typeof result.thread !== "object" || result.thread === null) {
    return undefined;
  }
  const thread = result.thread;
  if (
    !("id" in thread) ||
    !("providerInstanceId" in thread) ||
    !("modelId" in thread) ||
    typeof thread.id !== "string" ||
    typeof thread.providerInstanceId !== "string" ||
    typeof thread.modelId !== "string"
  ) {
    return undefined;
  }
  return { id: thread.id, providerInstanceId: thread.providerInstanceId, modelId: thread.modelId };
}

function forked(mode: OctantMode, threadId: string, onSuggestingModel: boolean) {
  return { kind: "forked", mode, threadId: String(threadId), onSuggestingModel } as const;
}

function refused(message: string) {
  return { kind: "refused", message } as const;
}

export interface SideTaskHerePorts {
  readonly queue: Pick<ThreadMessageQueueService, "withTurnStanding" | "read" | "execute">;
  readonly sendTurn: (input: SideTaskTurnInput) => Promise<boolean>;
  readonly uuid: () => string;
}

/**
 * Gives an offer's prompt to the offering thread. The thread's message queue
 * says where it stands for this window and holds its ordering while an idle
 * thread is sent the prompt as its next turn, so no queued message or
 * dispatch lands in between. A running thread gets the prompt queued behind
 * its turn, under the queue's usual holds. A thread whose last message may
 * not have gone out, that takes no new message (archived, completed, marked
 * Done, or without its checkout), or that this window cannot reach, is sent
 * nothing.
 */
export async function continueInThread(
  ports: SideTaskHerePorts,
  input: SideTaskTurnInput,
): Promise<SideTaskHereOutcome> {
  const windowId = decodeWindowId(input.windowId);
  const scope = decodeThreadMessageQueueScope({ mode: input.mode, threadId: input.threadId });
  const now = await ports.queue.withTurnStanding(
    windowId,
    scope,
    async (standing): Promise<SideTaskHereOutcome | "queue"> => {
      if (standing === "active") return "queue";
      if (standing === "unconfirmed") {
        return refused(
          "This thread's last message may not have gone out. Check the thread, then try again.",
        );
      }
      if (standing === "unavailable") return refused("This thread cannot take a message now.");
      return (await ports.sendTurn(input).catch(() => false))
        ? { kind: "sent" }
        : refused("The prompt could not be sent to this thread.");
    },
    "dispatch",
  );
  if (now !== "queue") return now;
  // A queue another window changed in between is read again once; a second
  // conflict is left for the person to retry.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const read = await ports.queue.read(windowId, scope);
    if (read.status !== "ready") return refused(queueRefusal(read.reason));
    const enqueued = await ports.queue.execute(
      windowId,
      decodeThreadMessageQueueCommand({
        kind: "enqueue",
        scope,
        requestId: ports.uuid(),
        expectedVersion: read.snapshot.version,
        messageId: ports.uuid(),
        payload: { mode: input.mode, prompt: input.prompt },
      }),
    );
    if (enqueued.status === "refused") return refused(queueRefusal(enqueued.reason));
    if (enqueued.status !== "conflict") return { kind: "queued" };
  }
  return refused("This thread's message queue changed. Try again.");
}

function queueRefusal(reason: ThreadMessageQueueRefusalReason): string {
  if (reason === "queue-full") return "This thread's message queue is full.";
  if (reason === "unauthorized" || reason === "authority-revoked") {
    return "This window cannot queue a message on this thread.";
  }
  return "The prompt could not be queued on this thread.";
}
