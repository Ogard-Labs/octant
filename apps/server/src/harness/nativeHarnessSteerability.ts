import type { NativeHarnessSessionView, ProviderInstanceId } from "@octant/contracts";
import type { NativeHarnessSessionStore } from "./nativeHarnessSessionStore";

type DeliversSteering = (providerInstanceId: ProviderInstanceId) => boolean;

/**
 * A runtime provider (Codex, Claude Code) keeps a session for recovery but
 * never reads queued notes, so only a native-harness lead is steerable.
 */
export function withSteerable(
  view: NativeHarnessSessionView,
  deliversSteering: DeliversSteering,
): NativeHarnessSessionView {
  return { ...view, steerable: deliversSteering(view.session.lead.providerInstanceId) };
}

/** Refuses to queue a note no run of this thread's lead would read. */
export function queueSteeringWhereDelivered(
  sessions: Pick<NativeHarnessSessionStore, "read" | "queueSteering">,
  deliversSteering: DeliversSteering,
  threadId: string,
  note: Parameters<NativeHarnessSessionStore["queueSteering"]>[1],
): ReturnType<NativeHarnessSessionStore["queueSteering"]> | "no-session" {
  const lead = sessions.read(threadId)?.session.lead;
  if (lead !== undefined && !deliversSteering(lead.providerInstanceId)) return "no-session";
  return sessions.queueSteering(threadId, note);
}
