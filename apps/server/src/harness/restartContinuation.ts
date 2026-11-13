import { createHash, randomUUID } from "node:crypto";
import {
  decodeThreadMessageQueueCommand,
  decodeThreadMessageQueueScope,
  type OctantMode,
  type WindowId,
} from "@octant/contracts";
import type { ThreadMessageQueueService } from "../messageQueue/threadMessageQueueService";

/** What a thread is told when it continues a turn a restart cut off, by a person or by the host. */
export const RESTART_CONTINUATION_PROMPT =
  "Octant restarted before your previous turn finished. Inspect the saved conversation and any work already performed, then continue the unfinished request. Do not blindly repeat operations that may already have taken effect. Ask again for any approval or answer still needed.";
const prompt = RESTART_CONTINUATION_PROMPT;

/**
 * The one continuation identity a recovery identity ever gets, so a retried
 * or repeated recovery lands on the record the first one wrote instead of
 * starting a second continuation.
 */
export function restartContinuationId(recoveryIdentity: string): string {
  const hash = createHash("sha256").update(`octant:restart:${recoveryIdentity}`).digest("hex");
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

/**
 * After the host continued a turn a restart cut off, lets the messages queued
 * behind that turn follow the continuation. A restart holds every queue; this
 * lifts only that hold, under the given scope, so the queue's own dispatch
 * check still waits for the continuation to end and still holds on a failed
 * or cancelled one. A queue the person paused stays paused.
 */
export async function releaseQueueBehindRestartContinuation(
  queue: Pick<ThreadMessageQueueService, "read" | "execute">,
  input: { readonly scopeId: WindowId; readonly threadId: string; readonly mode: OctantMode },
): Promise<void> {
  const scope = decodeThreadMessageQueueScope({ mode: input.mode, threadId: input.threadId });
  const read = await queue.read(input.scopeId, scope);
  if (
    read.status !== "ready" ||
    read.snapshot.items.length === 0 ||
    read.snapshot.paused ||
    read.snapshot.holdReason !== "host-restart"
  )
    return;
  await queue.execute(
    input.scopeId,
    decodeThreadMessageQueueCommand({
      kind: "resume",
      scope,
      requestId: randomUUID(),
      expectedVersion: read.snapshot.version,
    }),
  );
}

/** Use the existing durable queue receipt, not a window-local flag, to deduplicate recovery. */
export async function queueRestartContinuation(
  queue: Pick<ThreadMessageQueueService, "read" | "execute">,
  input: {
    readonly windowId: WindowId;
    readonly threadId: string;
    readonly mode: OctantMode;
    readonly recoveryIdentity: string;
  },
): Promise<{ readonly kind: "queued" } | { readonly kind: "refused"; readonly message: string }> {
  const messageId = restartContinuationId(input.recoveryIdentity);
  const scope = decodeThreadMessageQueueScope({ mode: input.mode, threadId: input.threadId });
  const refused = (message: string) => ({ kind: "refused" as const, message });
  const read = await queue.read(input.windowId, scope);
  if (read.status !== "ready") return refused(`Cannot continue this thread: ${read.reason}.`);
  if (read.snapshot.items.some((item) => String(item.messageId) !== messageId)) {
    return refused(
      "This thread already has queued messages. Review and remove them from the queue before resuming this interrupted turn.",
    );
  }
  const enqueued = await queue.execute(
    input.windowId,
    decodeThreadMessageQueueCommand({
      kind: "enqueue",
      scope,
      requestId: randomUUID(),
      expectedVersion: read.snapshot.version,
      messageId,
      payload: { mode: input.mode, prompt },
    }),
  );
  if (enqueued.status === "refused")
    return refused(`Could not queue the continuation: ${enqueued.reason}.`);
  if (enqueued.status === "conflict")
    return refused("The message queue changed. Review it and try again.");
  // A concurrent enqueue must not let this button unpause unrelated work.
  if (enqueued.snapshot.items.some((item) => String(item.messageId) !== messageId)) {
    return refused(
      "The continuation is queued. Review and remove the other queued messages before resuming this interrupted turn.",
    );
  }
  if (enqueued.snapshot.paused || enqueued.snapshot.holdReason !== undefined) {
    const resumed = await queue.execute(
      input.windowId,
      decodeThreadMessageQueueCommand({
        kind: "resume",
        scope,
        requestId: randomUUID(),
        expectedVersion: enqueued.snapshot.version,
      }),
    );
    if (resumed.status === "refused")
      return refused(`The continuation is queued but held: ${resumed.reason}.`);
    if (resumed.status === "conflict")
      return refused("The continuation is queued. Review the queue before resuming.");
  }
  return { kind: "queued" };
}
