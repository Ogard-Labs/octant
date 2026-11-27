import {
  type CodeOperationCommand,
  decodeCancelWorkTurnCommand,
  decodeHostAnswer,
  decodeThreadMessageQueueCommand,
  decodeThreadMessageQueuePayload,
  decodeThreadMessageQueueScope,
  type ThreadMessageQueueCommand,
  ThreadMessageQueueReadResult,
  type ThreadMessageQueueRefusalReason,
  ThreadMessageQueueResult,
  type ThreadMessageQueueSnapshot,
  WorkTurnCancelResult,
} from "@octant/contracts";
import { executeMobileCodeOperation } from "./mobileCodeOperationsClient";
import { MobileInboxFailure, type MobileRemoteTransport } from "./mobileInboxClient";
import { postWithTypedClaim } from "./typedClaim";

/*
 * Acting on a running turn from the phone: the person's own Stop, and the
 * thread's message queue. Both are the computer's. The queue lives there, so
 * the phone keeps nothing to send later.
 */

export type MobileStopResult =
  | { readonly status: "stopped" }
  | { readonly status: "refused"; readonly message: string };

const STOP_FAILED = "The turn could not be stopped. Nothing changed.";
const QUEUE_FAILED = "The message queue is unavailable. Your draft stays here.";

async function refusalMessage(response: Response, fallback: string): Promise<string> {
  try {
    const body: unknown = await response.json();
    if (typeof body === "object" && body !== null && "message" in body) {
      const { message } = body;
      if (typeof message === "string" && message.trim().length > 0) return message;
    }
  } catch {
    // The status alone says it was refused.
  }
  return fallback;
}

/** Stops the Work turn the person saw running; a turn that already ended is stopped. */
export async function stopMobileWorkTurn(input: {
  readonly transport: MobileRemoteTransport;
  readonly threadId: string;
  readonly turnId: string;
  readonly requestId: string;
}): Promise<MobileStopResult> {
  const response = await input.transport.authenticatedFetch({
    method: "POST",
    path: "/api/work/turns/cancel",
    body: JSON.stringify(
      decodeCancelWorkTurnCommand({
        kind: "cancel-work-turn",
        requestId: input.requestId,
        threadId: input.threadId,
        turnId: input.turnId,
      }),
    ),
  });
  if (!response.ok)
    return { status: "refused", message: await refusalMessage(response, STOP_FAILED) };
  try {
    const result = decodeHostAnswer(WorkTurnCancelResult)(await response.json());
    return String(result.turnId) === input.turnId
      ? { status: "stopped" }
      : { status: "refused", message: STOP_FAILED };
  } catch {
    return { status: "refused", message: STOP_FAILED };
  }
}

/** Stops the Code turn the person saw running, and no turn that replaced it. */
export async function stopMobileCodeTurn(input: {
  readonly transport: MobileRemoteTransport;
  readonly threadId: string;
  readonly checkoutId: string;
  readonly turnOperationId: string;
}): Promise<MobileStopResult> {
  type Cancel = Extract<CodeOperationCommand, { readonly kind: "cancel-provider-turn" }>;
  const result = await executeMobileCodeOperation(input.transport, {
    kind: "cancel-provider-turn",
    operationId: globalThis.crypto.randomUUID() as Cancel["operationId"],
    threadId: input.threadId as Cancel["threadId"],
    checkoutId: input.checkoutId as Cancel["checkoutId"],
    turnOperationId: input.turnOperationId as NonNullable<Cancel["turnOperationId"]>,
  });
  // A stop that came too late answers as that turn's state, which is no stop.
  if (result.kind === "provider-turn-state" && result.state === "failed")
    return { status: "refused", message: result.failure?.message ?? STOP_FAILED };
  return result.kind === "operation-failed"
    ? { status: "refused", message: result.failure.message }
    : { status: "stopped" };
}

export interface MobileQueueScope {
  readonly mode: "chat" | "work" | "code";
  readonly threadId: string;
}

export type MobileQueueResult =
  | { readonly status: "queued"; readonly snapshot: ThreadMessageQueueSnapshot }
  | { readonly status: "refused"; readonly message: string };

/**
 * A send also ends with no answer at all, which says nothing of the message, or
 * withdrawn by the person before it left.
 */
export type MobileSendResult =
  | MobileQueueResult
  | { readonly status: "unreachable" }
  | { readonly status: "withdrawn" };

const REFUSAL: Readonly<Partial<Record<ThreadMessageQueueRefusalReason, string>>> = {
  unauthorized: "This phone may not queue messages here.",
  "authority-revoked": "This phone may not queue messages here.",
  "queue-full": "The queue is full.",
  "invalid-payload": "This message cannot be queued.",
  "not-found": "That message is no longer queued.",
  "not-editable": "That message is already being sent.",
  "thread-unavailable": "This thread is unavailable.",
  "storage-unavailable": "The computer could not store the message.",
  paused: "The queue is paused on the computer. Resume it there first.",
};

function heldFor(
  snapshot: ThreadMessageQueueSnapshot,
  scope: MobileQueueScope,
): ThreadMessageQueueSnapshot {
  if (
    snapshot.scope.mode !== scope.mode ||
    String(snapshot.scope.threadId) !== String(scope.threadId)
  )
    throw new MobileInboxFailure("unavailable", "The host returned a different thread's queue.");
  return snapshot;
}

/** What waits in the thread's queue; undefined where this phone may not read one. */
export async function loadMobileMessageQueue(
  transport: MobileRemoteTransport,
  scope: MobileQueueScope,
): Promise<ThreadMessageQueueSnapshot | undefined> {
  const response = await transport.authenticatedFetch({
    method: "GET",
    path: "/api/thread-message-queue",
    query: `?${new URLSearchParams({ mode: scope.mode, threadId: scope.threadId })}`,
  });
  // An older computer has no queue, and some sessions may not read one. Any
  // other failure says nothing about the queue.
  if (response.status === 401 || response.status === 403 || response.status === 404)
    return undefined;
  if (!response.ok)
    throw new MobileInboxFailure("unavailable", "The message queue could not be read.");
  const result = decodeHostAnswer(ThreadMessageQueueReadResult)(await response.json());
  return result.status === "refused" ? undefined : heldFor(result.snapshot, scope);
}

async function send(
  transport: MobileRemoteTransport,
  command: ThreadMessageQueueCommand,
): Promise<ThreadMessageQueueResult | string> {
  // A host that predates the typed claim refuses it as invalid, so the same
  // command goes once more without it.
  const response = await postWithTypedClaim(command, (body) =>
    transport.authenticatedFetch({
      method: "POST",
      path: "/api/thread-message-queue/commands",
      body: JSON.stringify(body),
    }),
  );
  if (response.status >= 500)
    throw new MobileInboxFailure("unavailable", "The message queue did not answer.");
  if (!response.ok) return refusalMessage(response, QUEUE_FAILED);
  const result = decodeHostAnswer(ThreadMessageQueueResult)(await response.json());
  if (result.requestId !== command.requestId) return QUEUE_FAILED;
  if (result.status !== "refused")
    heldFor(result.snapshot, {
      mode: command.scope.mode,
      threadId: String(command.scope.threadId),
    });
  return result;
}

/** Sends a command on the version read, and once more on the computer's when that moved. */
async function change(
  transport: MobileRemoteTransport,
  snapshot: ThreadMessageQueueSnapshot,
  fields: Readonly<Record<string, unknown>>,
  stillWanted?: () => boolean,
): Promise<MobileSendResult> {
  let held = snapshot;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (stillWanted?.() === false) return { status: "withdrawn" };
    const result = await send(
      transport,
      decodeThreadMessageQueueCommand({
        ...fields,
        scope: decodeThreadMessageQueueScope(held.scope),
        requestId: globalThis.crypto.randomUUID(),
        expectedVersion: held.version,
      }),
    );
    if (typeof result === "string") return { status: "refused", message: result };
    if (result.status === "refused")
      return { status: "refused", message: REFUSAL[result.reason] ?? QUEUE_FAILED };
    if (result.status !== "conflict") return { status: "queued", snapshot: result.snapshot };
    held = result.snapshot;
  }
  return { status: "refused", message: "The queue changed. Try again." };
}

/**
 * Queues a message behind the running turn, or offers it to that turn where
 * the thread steers: which of the two is the computer's setting. An idle thread
 * starts on it at once.
 *
 * The computer keeps the id of every message it accepted, also once the message
 * has left the queue, and answers a second send of it without taking it again.
 * So a lost answer is asked for with the same id, now or by a later call: never
 * by looking for the message in the queue, which it may already have left.
 */
export async function queueMobileMessage(input: {
  readonly transport: MobileRemoteTransport;
  readonly scope: MobileQueueScope;
  /** The same for every attempt to send one message. */
  readonly messageId: string;
  readonly prompt: string;
  readonly attachmentIds?: ReadonlyArray<string>;
  /** The person typed these words on this phone. */
  readonly typedByPerson?: boolean;
  /** Asked each time just before the message leaves. */
  readonly stillWanted?: () => boolean;
}): Promise<MobileSendResult> {
  const payload = {
    mode: input.scope.mode,
    prompt: input.prompt,
    ...(input.attachmentIds === undefined || input.attachmentIds.length === 0
      ? {}
      : { attachmentIds: input.attachmentIds }),
    ...(input.typedByPerson === true ? { typedByPerson: true } : {}),
  };
  try {
    decodeThreadMessageQueuePayload(payload);
  } catch {
    // A message the contract does not take will not be taken later either.
    return { status: "refused", message: "This message cannot be queued." };
  }
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const snapshot = await loadMobileMessageQueue(input.transport, input.scope);
      if (input.stillWanted?.() === false) return { status: "withdrawn" };
      if (snapshot === undefined)
        return {
          status: "refused",
          message: "This computer takes no message from this phone here.",
        };
      return await change(
        input.transport,
        snapshot,
        { kind: "enqueue", messageId: input.messageId, payload },
        input.stillWanted,
      );
    } catch {
      // Lost, or an answer this build cannot read: asked again, then left open.
    }
  }
  return { status: "unreachable" };
}

export async function removeMobileQueuedMessage(input: {
  readonly transport: MobileRemoteTransport;
  readonly snapshot: ThreadMessageQueueSnapshot;
  readonly messageId: string;
}): Promise<MobileSendResult> {
  try {
    return await change(input.transport, input.snapshot, {
      kind: "remove",
      messageId: input.messageId,
    });
  } catch {
    return { status: "refused", message: QUEUE_FAILED };
  }
}

/** Changes a waiting message's words, while it still waits. */
export async function editMobileQueuedMessage(input: {
  readonly transport: MobileRemoteTransport;
  readonly snapshot: ThreadMessageQueueSnapshot;
  readonly messageId: string;
  readonly prompt: string;
  readonly typedByPerson?: boolean;
}): Promise<MobileSendResult> {
  try {
    return await change(input.transport, input.snapshot, {
      kind: "edit",
      messageId: input.messageId,
      prompt: input.prompt.trim(),
      ...(input.typedByPerson === true ? { typedByPerson: true } : {}),
    });
  } catch {
    return { status: "refused", message: QUEUE_FAILED };
  }
}

/**
 * Moves a waiting message to the front of the queue. The computer may then
 * steer it into the running turn, never a paired device's own message, which
 * waits at the front for the next turn.
 */
export async function sendMobileQueuedMessageNow(input: {
  readonly transport: MobileRemoteTransport;
  readonly snapshot: ThreadMessageQueueSnapshot;
  readonly messageId: string;
}): Promise<MobileSendResult> {
  try {
    return await change(input.transport, input.snapshot, {
      kind: "send-now",
      messageId: input.messageId,
    });
  } catch {
    return { status: "refused", message: QUEUE_FAILED };
  }
}
