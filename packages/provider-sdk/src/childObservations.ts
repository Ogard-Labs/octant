import {
  MAX_PROVIDER_CHILD_HISTORY,
  MAX_PROVIDER_CHILD_OBSERVATIONS,
  type ProviderChildActivityEvent,
  type ProviderChildObservation,
  type ProviderChildObservationState,
} from "@octant/contracts";

/** Fold reports within one host-admitted parent, never across authority scopes. */
export function recordProviderChildObservation(
  state: ProviderChildObservationState | undefined,
  event: Omit<ProviderChildActivityEvent, "kind" | "correlationId">,
): ProviderChildObservationState {
  const current = state ?? { children: [], truncated: false };
  const matches = (child: ProviderChildObservation) =>
    child.providerInstanceId === event.instanceId &&
    child.sessionId === event.sessionId &&
    child.childAgentId === event.childAgentId;
  const conflictingIdentity = current.children.find(
    (child) =>
      child.providerInstanceId === event.instanceId &&
      child.sessionId === event.sessionId &&
      child.childAgentId !== event.childAgentId &&
      child.history.some((entry) => entry.sequence === event.sequence),
  );
  if (conflictingIdentity !== undefined)
    return {
      ...current,
      truncated: true,
      children: current.children.map((child) =>
        child === conflictingIdentity || matches(child)
          ? { ...child, lifecycleStatus: "unknown", historyStatus: "conflicted" }
          : child,
      ),
    };
  const previous = current.children.find(matches);
  const entry = {
    sequence: event.sequence,
    occurredAt: event.occurredAt,
    status: event.status,
    summary: event.summary.slice(0, 512),
  };
  const priorEntry = previous?.history.find((item) => item.sequence === event.sequence);
  const conflicts =
    previous !== undefined &&
    ((event.parentChildAgentId !== undefined &&
      previous.parentChildAgentId !== event.parentChildAgentId) ||
      (event.modelId !== undefined &&
        previous.modelId !== undefined &&
        previous.modelId !== event.modelId) ||
      (priorEntry !== undefined && JSON.stringify(priorEntry) !== JSON.stringify(entry)));
  if (previous?.historyStatus === "conflicted") return current;
  if (conflicts || event.parentChildAgentId === event.childAgentId) {
    if (previous === undefined) return current;
    return {
      ...current,
      children: current.children.map((child) =>
        matches(child)
          ? { ...child, lifecycleStatus: "unknown", historyStatus: "conflicted" }
          : child,
      ),
    };
  }
  // A replay older than retained history cannot resurrect a previous state.
  if (previous !== undefined && event.sequence <= (previous.history.at(-1)?.sequence ?? 0))
    return current;
  if (previous === undefined && current.children.length >= MAX_PROVIDER_CHILD_OBSERVATIONS) {
    return current.truncated ? current : { ...current, truncated: true };
  }
  const history = [...(previous?.history ?? []), entry];
  const parentChildAgentId = event.parentChildAgentId ?? previous?.parentChildAgentId;
  const child: ProviderChildObservation = {
    providerInstanceId: event.instanceId,
    sessionId: event.sessionId,
    childAgentId: event.childAgentId,
    ...(parentChildAgentId === undefined ? {} : { parentChildAgentId }),
    ...((event.modelId ?? previous?.modelId)
      ? { modelId: event.modelId ?? previous?.modelId }
      : {}),
    ...((event.task ?? previous?.task) ? { task: event.task ?? previous?.task } : {}),
    lifecycleStatus: event.status,
    latestSummary: entry.summary,
    firstObservedAt: previous?.firstObservedAt ?? event.occurredAt,
    updatedAt: event.occurredAt,
    historyStatus:
      history.length > MAX_PROVIDER_CHILD_HISTORY ||
      event.summary.length > 512 ||
      previous?.historyStatus === "truncated"
        ? "truncated"
        : "partial",
    history: history.slice(-MAX_PROVIDER_CHILD_HISTORY),
  };
  return {
    ...current,
    children:
      previous === undefined
        ? [...current.children, child]
        : current.children.map((item) => (matches(item) ? child : item)),
  };
}
