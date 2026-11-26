import {
  decodeHostAnswer,
  decodeThreadMessageQueueCommand,
  decodeThreadQueueMessageId,
  ThreadMessageQueueReadResult,
  ThreadMessageQueueResult,
  type ThreadMessageQueueCommand,
  type ThreadMessageQueueRefusalReason,
  type ThreadMessageQueueSnapshot,
} from "@octant/contracts";
import { MobileInboxFailure, type MobileRemoteTransport } from "./mobileInboxClient";
import { postWithTypedClaim } from "./typedClaim";

/**
 * A paired phone's side of a thread's message queue, on the host's own queue
 * routes. The host checks the device's pairing, access level, the mode's send
 * action and the Project on every command and again at dispatch, and keeps a
 * restricted device to its own messages; nothing here decides any of that.
 */
export interface MobileQueueScope {
  readonly mode: "work" | "code";
  readonly threadId: string;
}

const REFUSALS: Partial<Record<ThreadMessageQueueRefusalReason, string>> = {
  unauthorized: "This phone may not change that message.",
  "not-found": "That message has already left the queue.",
  "not-editable": "That message is already on its way and can no longer change.",
  "queue-full": "The queue is full. Wait for a message to go first.",
  "invalid-payload": "The host could not take that message.",
  "storage-unavailable": "The host could not store the message.",
  paused: "The queue is paused on the host.",
};

function refusal(reason: ThreadMessageQueueRefusalReason): string {
  return REFUSALS[reason] ?? "The host is holding this thread's queue.";
}

async function decodeAnswer<T>(response: Response, decode: (value: unknown) => T): Promise<T> {
  if (!response.ok) {
    throw new MobileInboxFailure(
      response.status === 403 ? "rejected" : "unavailable",
      "The host message queue is unavailable.",
    );
  }
  try {
    return decode(await response.json());
  } catch {
    throw new MobileInboxFailure("unavailable", "The host returned an invalid queue answer.");
  }
}

/** The thread's queue as the host holds it now. */
export async function readMobileThreadMessageQueue(
  transport: MobileRemoteTransport,
  scope: MobileQueueScope,
): Promise<ThreadMessageQueueSnapshot> {
  const result = await decodeAnswer(
    await transport.authenticatedFetch({
      method: "GET",
      path: "/api/thread-message-queue",
      query: new URLSearchParams({ mode: scope.mode, threadId: scope.threadId }).toString(),
    }),
    decodeHostAnswer(ThreadMessageQueueReadResult),
  );
  if (result.status === "refused")
    throw new MobileInboxFailure("unavailable", refusal(result.reason));
  if (String(result.snapshot.scope.threadId) !== scope.threadId) {
    throw new MobileInboxFailure("unavailable", "The host returned a different thread's queue.");
  }
  return result.snapshot;
}

async function run(
  transport: MobileRemoteTransport,
  unchecked: unknown,
): Promise<ThreadMessageQueueSnapshot> {
  let command: ThreadMessageQueueCommand;
  try {
    command = decodeThreadMessageQueueCommand(unchecked);
  } catch {
    throw new MobileInboxFailure("unavailable", "That message cannot be queued.");
  }
  const result = await decodeAnswer(
    await postWithTypedClaim(command, (body) =>
      transport.authenticatedFetch({
        method: "POST",
        path: "/api/thread-message-queue/commands",
        body: JSON.stringify(body),
        contentType: "application/json",
      }),
    ),
    decodeHostAnswer(ThreadMessageQueueResult),
  );
  if (String(result.requestId) !== String(command.requestId)) {
    throw new MobileInboxFailure("unavailable", "The host answered a different queue change.");
  }
  if (result.status === "refused") throw new MobileInboxFailure("rejected", refusal(result.reason));
  if (result.status === "conflict") {
    throw new MobileInboxFailure("stale", "The queue changed on the host. Look again and retry.");
  }
  return result.snapshot;
}

function base(scope: MobileQueueScope, expectedVersion: number) {
  return { scope, requestId: crypto.randomUUID(), expectedVersion };
}

/**
 * Queues a follow-up typed while the thread's turn runs. It waits for that
 * turn to end: the host never steers a paired device's message into a turn.
 */
export function queueMobileFollowUp(input: {
  readonly transport: MobileRemoteTransport;
  readonly scope: MobileQueueScope;
  readonly expectedVersion: number;
  readonly prompt: string;
  readonly typedByPerson?: true;
}): Promise<ThreadMessageQueueSnapshot> {
  return run(input.transport, {
    kind: "enqueue",
    ...base(input.scope, input.expectedVersion),
    messageId: decodeThreadQueueMessageId(crypto.randomUUID()),
    payload: {
      mode: input.scope.mode,
      prompt: input.prompt.trim(),
      ...(input.typedByPerson === true ? { typedByPerson: true } : {}),
    },
  });
}

export function editMobileQueuedMessage(input: {
  readonly transport: MobileRemoteTransport;
  readonly scope: MobileQueueScope;
  readonly expectedVersion: number;
  readonly messageId: string;
  readonly prompt: string;
  readonly typedByPerson?: true;
}): Promise<ThreadMessageQueueSnapshot> {
  return run(input.transport, {
    kind: "edit",
    ...base(input.scope, input.expectedVersion),
    messageId: input.messageId,
    prompt: input.prompt.trim(),
    ...(input.typedByPerson === true ? { typedByPerson: true } : {}),
  });
}

export function removeMobileQueuedMessage(input: {
  readonly transport: MobileRemoteTransport;
  readonly scope: MobileQueueScope;
  readonly expectedVersion: number;
  readonly messageId: string;
}): Promise<ThreadMessageQueueSnapshot> {
  return run(input.transport, {
    kind: "remove",
    ...base(input.scope, input.expectedVersion),
    messageId: input.messageId,
  });
}
