import { createHash, randomUUID } from "node:crypto";
import {
  decodeThreadMessageQueueCommand,
  decodeThreadMessageQueueScope,
  type OctantMode,
  type ThreadMessageQueueSnapshot,
  type WindowId,
} from "@octant/contracts";
import type { ThreadMessageQueueService } from "../messageQueue/threadMessageQueueService";

const prompt =
  "Octant restarted before your previous turn finished. Inspect the saved conversation and any work already performed, then continue the unfinished request. Do not blindly repeat operations that may already have taken effect. Ask again for any approval or answer still needed.";

/**
 * Use the existing durable queue receipt, not a window-local flag, to deduplicate recovery.
 * Messages already queued need no review: the continuation goes ahead of them
 * and they stay queued. A queue the person paused stays paused.
 */
export async function queueRestartContinuation(
  queue: Pick<ThreadMessageQueueService, "read" | "execute">,
  input: {
    readonly windowId: WindowId;
    readonly threadId: string;
    readonly mode: OctantMode;
    readonly recoveryIdentity: string;
  },
): Promise<{ readonly kind: "queued" } | { readonly kind: "refused"; readonly message: string }> {
  const hash = createHash("sha256")
    .update(`octant:restart:${input.recoveryIdentity}`)
    .digest("hex");
  const messageId = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
  const scope = decodeThreadMessageQueueScope({ mode: input.mode, threadId: input.threadId });
  const refused = (message: string) => ({ kind: "refused" as const, message });
  const changed = () => refused("The message queue changed. Review it and try again.");
  const read = await queue.read(input.windowId, scope);
  if (read.status !== "ready") return refused(`Cannot continue this thread: ${read.reason}.`);
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
  if (enqueued.status === "conflict") return changed();
  let snapshot = enqueued.snapshot;
  const ahead = continuationFirst(snapshot, messageId);
  if (ahead !== undefined) {
    const reordered = await queue.execute(
      input.windowId,
      decodeThreadMessageQueueCommand({
        kind: "reorder",
        scope,
        requestId: randomUUID(),
        expectedVersion: snapshot.version,
        messageIds: ahead,
      }),
    );
    if (reordered.status === "refused")
      return refused(`The continuation is queued but could not go first: ${reordered.reason}.`);
    if (reordered.status === "conflict") return changed();
    snapshot = reordered.snapshot;
  }
  // The person's own pause covers what they queued; this button does not undo it.
  if (snapshot.paused && snapshot.items.some((item) => String(item.messageId) !== messageId)) {
    return refused(
      "The continuation is queued ahead of your paused messages. Resume the queue to continue.",
    );
  }
  if (snapshot.paused || snapshot.holdReason !== undefined) {
    const resumed = await queue.execute(
      input.windowId,
      decodeThreadMessageQueueCommand({
        kind: "resume",
        scope,
        requestId: randomUUID(),
        expectedVersion: snapshot.version,
      }),
    );
    if (resumed.status === "refused")
      return refused(`The continuation is queued but held: ${resumed.reason}.`);
    if (resumed.status === "conflict")
      return refused("The continuation is queued. Review the queue before resuming.");
  }
  return { kind: "queued" };
}

/**
 * The order that puts a still-queued continuation ahead of every other queued
 * message, or nothing when it is already there. A message being delivered or
 * already accepted keeps its place: the queue refuses to move it.
 */
function continuationFirst(
  snapshot: ThreadMessageQueueSnapshot,
  messageId: string,
): ReadonlyArray<string> | undefined {
  const continuation = snapshot.items.find((item) => String(item.messageId) === messageId);
  if (continuation?.status !== "queued") return undefined;
  const settled = snapshot.items.filter((item) => item.status !== "queued");
  const waiting = snapshot.items.filter(
    (item) => item.status === "queued" && item !== continuation,
  );
  const order = [...settled, continuation, ...waiting].map((item) => String(item.messageId));
  return order.every((id, index) => id === String(snapshot.items[index]?.messageId))
    ? undefined
    : order;
}
