import type { ThreadHandOffClient } from "@octant/client-runtime/thread-hand-off-client";
import { createThreadHandOffClient } from "@octant/client-runtime/thread-hand-off-client";
import type { OctantMode } from "@octant/contracts/modes";
import type { ThreadHandOffOutcome } from "@octant/contracts/thread-hand-off";

/** The hand-off client for a surface's props, resolved the way the export client is. */
export function resolveThreadHandOffClient(input: {
  readonly client?: ThreadHandOffClient;
  readonly serverUrl?: string;
  readonly windowCapability?: string;
}): ThreadHandOffClient | undefined {
  if (input.client !== undefined) return input.client;
  if (input.serverUrl === undefined || input.windowCapability === undefined) return undefined;
  return createThreadHandOffClient({
    baseUrl: input.serverUrl,
    fetch: globalThis.fetch,
    windowCapability: input.windowCapability,
  });
}

/**
 * Asks the host to hand off the thread. The host writes the document with the
 * thread's own provider and keeps it as a Canvas of the thread; the renderer
 * only reports what happened and opens what was written.
 */
export async function handOffThread(
  client: ThreadHandOffClient,
  input: { readonly mode: OctantMode; readonly threadId: string },
): Promise<ThreadHandOffOutcome> {
  try {
    return await client.handOffThread({ mode: input.mode, threadId: input.threadId });
  } catch {
    return { kind: "refused", reason: "document-not-produced" };
  }
}

/** One sentence a menu or the sidebar can show for the outcome. */
export function threadHandOffMessage(outcome: ThreadHandOffOutcome): string {
  if (outcome.kind === "handed-off") return `${outcome.title} is open in the dock.`;
  switch (outcome.reason) {
    case "turn-running":
      return "Wait for the running turn to finish before handing off.";
    case "provider-unavailable":
      return outcome.message ?? "This thread's provider is not available.";
    case "project-required":
      return "Move the thread into a Project first; the hand-off document lives there.";
    case "empty-thread":
      return "There is nothing to hand off yet.";
    case "unauthorized":
      return "This thread cannot be handed off from this window.";
    case "not-found":
      return "This thread could not be handed off.";
    case "document-refused":
      return outcome.message ?? "The hand-off document could not be kept.";
    case "document-not-produced":
      return outcome.message ?? "The provider did not produce a hand-off document.";
  }
}
