import {
  type ThreadMessageQueueCommand,
  ThreadMessageQueueResult,
  type ThreadMessageQueueScope,
  type ThreadMessageQueueSnapshot,
  ThreadMessageQueueReadResult,
  decodeHostAnswer,
} from "@octant/contracts";
import { sendWithTypedClaim } from "@octant/client-runtime/typed-claim";

/** The host answered the request with this HTTP status. */
class QueueRequestRefused extends Error {
  constructor(readonly status: number) {
    super("The host message queue is unavailable.");
  }
}

export interface ThreadMessageQueueClient {
  readonly read: (scope: ThreadMessageQueueScope) => Promise<ThreadMessageQueueSnapshot>;
  readonly execute: (command: ThreadMessageQueueCommand) => Promise<ThreadMessageQueueResult>;
}

export function createThreadMessageQueueClient(options: {
  readonly serverUrl: string;
  readonly windowCapability: string;
  readonly fetch?: typeof fetch;
}): ThreadMessageQueueClient {
  const request = options.fetch ?? globalThis.fetch;
  const base = options.serverUrl.replace(/\/$/, "");
  const headers = { "x-octant-window-capability": options.windowCapability };
  async function json(path: string, init: RequestInit): Promise<unknown> {
    const response = await request(`${base}${path}`, {
      signal: AbortSignal.timeout(15000),
      ...init,
    });
    if (!response.ok) throw new QueueRequestRefused(response.status);
    return await response.json();
  }
  return {
    read: async (scope) => {
      const query = new URLSearchParams({ mode: scope.mode, threadId: String(scope.threadId) });
      const result = decodeHostAnswer(ThreadMessageQueueReadResult)(
        await json(`/api/thread-message-queue?${query}`, { headers, cache: "no-store" }),
      );
      if (result.status === "refused") throw new Error(`Queue unavailable: ${result.reason}.`);
      const snapshot = result.snapshot;
      if (
        snapshot.scope.mode !== scope.mode ||
        String(snapshot.scope.threadId) !== String(scope.threadId)
      ) {
        throw new Error("The host returned a different thread's queue.");
      }
      return snapshot;
    },
    execute: async (command) => {
      const refusedAsInvalid = (error: unknown) =>
        error instanceof QueueRequestRefused && error.status === 400;
      const send = (sent: ThreadMessageQueueCommand) =>
        sendWithTypedClaim(
          sent,
          (body) =>
            json("/api/thread-message-queue/commands", {
              method: "POST",
              headers: { ...headers, "content-type": "application/json" },
              body: JSON.stringify(body),
            }),
          refusedAsInvalid,
        );
      let answer: unknown;
      try {
        answer = await send(command);
      } catch (error) {
        // A host that predates Send now rejects the command before it does
        // anything, so this is a refusal the composer can show, not a lost
        // request it must hold its receipt for and check again.
        if (command.kind === "send-now" && refusedAsInvalid(error)) {
          return {
            status: "refused",
            requestId: command.requestId,
            reason: "invalid-payload",
            message:
              "This computer's Octant does not offer Send now yet. Update it to use Send now.",
          };
        }
        // A host that predates keeping a message for the next turn refuses
        // the unknown field before it does anything; the message goes once
        // more without it, as an older client sends it, and so may steer.
        if (command.kind !== "enqueue" || command.timing === undefined || !refusedAsInvalid(error))
          throw error;
        const { timing: _timing, ...steering } = command;
        answer = await send(steering);
      }
      const result = decodeHostAnswer(ThreadMessageQueueResult)(answer);
      if (
        result.requestId !== command.requestId ||
        (result.status !== "refused" &&
          (result.snapshot.scope.mode !== command.scope.mode ||
            String(result.snapshot.scope.threadId) !== String(command.scope.threadId)))
      ) {
        throw new Error("The host returned a different queue command's answer.");
      }
      return result;
    },
  };
}
