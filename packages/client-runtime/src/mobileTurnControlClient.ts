import {
  type CodeOperationCommand,
  decodeCancelWorkTurnCommand,
  decodeHostAnswer,
  decodeThreadMessageQueueCommand,
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

const REFUSAL: Readonly<Partial<Record<ThreadMessageQueueRefusalReason, string>>> = {
  unauthorized: "This phone may not queue messages here.",
  "authority-revoked": "This phone may not queue messages here.",
  "queue-full": "The queue is full.",
  "invalid-payload": "This message cannot be queued.",
  "not-found": "That message is no longer queued.",
  "not-editable": "That message is already being sent.",
  "thread-unavailable": "This thread is unavailable.",
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
  // An older computer has no queue, and some sessions may not read one.
  if (!response.ok) return undefined;
  const result = decodeHostAnswer(ThreadMessageQueueReadResult)(await response.json());
  return result.status === "refused" ? undefined : heldFor(result.snapshot, scope);
}

async function send(
  transport: MobileRemoteTransport,
  command: ThreadMessageQueueCommand,
): Promise<ThreadMessageQueueResult | string> {
  const response = await transport.authenticatedFetch({
    method: "POST",
    path: "/api/thread-message-queue/commands",
    body: JSON.stringify(command),
  });
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
): Promise<MobileQueueResult> {
  let held = snapshot;
  for (let attempt = 0; attempt < 2; attempt += 1) {
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
 * the thread steers: which of the two is the computer's setting.
 */
export async function queueMobileMessage(input: {
  readonly transport: MobileRemoteTransport;
  readonly snapshot: ThreadMessageQueueSnapshot;
  readonly prompt: string;
  readonly attachmentIds?: ReadonlyArray<string>;
}): Promise<MobileQueueResult> {
  const { transport, snapshot } = input;
  const scope = { mode: snapshot.scope.mode, threadId: String(snapshot.scope.threadId) };
  const messageId = globalThis.crypto.randomUUID();
  try {
    return await change(transport, snapshot, {
      kind: "enqueue",
      messageId,
      payload: {
        mode: scope.mode,
        prompt: input.prompt,
        ...(input.attachmentIds === undefined || input.attachmentIds.length === 0
          ? {}
          : { attachmentIds: input.attachmentIds }),
      },
    });
  } catch {
    // The answer was lost, not necessarily the message: only the computer knows.
    const held = await loadMobileMessageQueue(transport, scope).catch(() => undefined);
    return held !== undefined && held.items.some((item) => String(item.messageId) === messageId)
      ? { status: "queued", snapshot: held }
      : { status: "refused", message: QUEUE_FAILED };
  }
}

export async function removeMobileQueuedMessage(input: {
  readonly transport: MobileRemoteTransport;
  readonly snapshot: ThreadMessageQueueSnapshot;
  readonly messageId: string;
}): Promise<MobileQueueResult> {
  try {
    return await change(input.transport, input.snapshot, {
      kind: "remove",
      messageId: input.messageId,
    });
  } catch {
    return { status: "refused", message: QUEUE_FAILED };
  }
}
