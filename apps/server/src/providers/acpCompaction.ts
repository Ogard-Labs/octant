import type { ProviderSessionCompaction } from "@octant/provider-sdk/driver";
import type { AcpClientPort } from "./acpDriver";

const uncertain = (): ProviderSessionCompaction => ({
  kind: "failed",
  message: "The runtime did not confirm a correlated context compaction.",
  sessionMayHaveChanged: true,
});

/** The exact command dialect emits a receipt only after native compaction succeeds. */
export async function compactAcpConversation(
  client: Pick<AcpClientPort, "prompt" | "notify" | "onNotification" | "onRequest">,
  sessionId: string,
  signal: AbortSignal,
): Promise<ProviderSessionCompaction> {
  if (signal.aborted) return uncertain();
  let receipt: string | undefined;
  let completed = false;
  let invalid = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  const remove = client.onNotification((message) => {
    if (message.params.sessionId !== sessionId) {
      invalid = true;
      return;
    }
    const update = message.params.update;
    // Usage is observed by the driver's ordinary usage reader. No text or
    // end_turn can stand in for this command's correlated native receipt.
    if (update.sessionUpdate === "usage_update" || update.sessionUpdate === "config_option_update")
      return;
    if (update.sessionUpdate === "tool_call") {
      if (
        receipt !== undefined ||
        typeof update.toolCallId !== "string" ||
        update.toolCallId.length === 0 ||
        update.toolCallId.length > 256 ||
        update.kind !== "other" ||
        update.status !== "in_progress" ||
        update.title !== "Compacting conversation history..."
      ) {
        invalid = true;
        return;
      }
      receipt = update.toolCallId;
      return;
    }
    if (update.sessionUpdate === "tool_call_update") {
      if (
        receipt === undefined ||
        completed ||
        update.toolCallId !== receipt ||
        update.status !== "completed" ||
        update.title !== "Compacted conversation history"
      ) {
        invalid = true;
        return;
      }
      completed = true;
      return;
    }
    invalid = true;
  });
  const removeRequests = client.onRequest(() => {
    invalid = true;
  });
  try {
    const stopped = new Promise<undefined>((resolve) => {
      abort = () => resolve(undefined);
      signal.addEventListener("abort", abort, { once: true });
      timer = setTimeout(() => resolve(undefined), 5 * 60_000);
      if (signal.aborted) abort();
    });
    const response = await Promise.race([
      Promise.resolve().then(() =>
        signal.aborted ? undefined : client.prompt(sessionId, "/compact"),
      ),
      stopped,
    ]);
    if (response === undefined) {
      if (timer !== undefined) clearTimeout(timer);
      // Cancellation addresses only this native session. Its owner subsequently
      // closes the connection, so uncertain history is not retained for reuse.
      await Promise.race([
        client.notify("session/cancel", { sessionId }).catch(() => undefined),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, 500);
        }),
      ]);
      return uncertain();
    }
    return !signal.aborted &&
      !invalid &&
      receipt !== undefined &&
      completed &&
      response.stopReason === "end_turn"
      ? { kind: "compacted" }
      : uncertain();
  } catch {
    return uncertain();
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (abort !== undefined) signal.removeEventListener("abort", abort);
    remove();
    removeRequests();
  }
}
