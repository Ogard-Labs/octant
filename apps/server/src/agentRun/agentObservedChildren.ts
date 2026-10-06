import { recordProviderChildObservation } from "@octant/provider-sdk/child-observations";
import {
  type AgentObservedChild,
  type AgentRunId,
  type AgentRunParentThreadId,
  type OctantMode,
  type ProviderChildActivityEvent,
  type ProviderChildObservation,
  type ProviderChildObservationState,
} from "@octant/contracts";

/** Reads only reports already owned by an authorized turn or managed child. */
export function observedChildren(input: {
  readonly parentThreadId: AgentRunParentThreadId;
  readonly mode: OctantMode;
  readonly parentRunId?: AgentRunId;
  readonly states?: ReadonlyArray<ProviderChildObservationState>;
  readonly events?: ReadonlyArray<ProviderChildActivityEvent>;
  readonly truncated?: boolean;
}): {
  readonly observations: ReadonlyArray<AgentObservedChild>;
  readonly observationsTruncated: boolean;
} {
  let state: ProviderChildObservationState = { children: [], truncated: input.truncated ?? false };
  for (const snapshot of input.states ?? []) {
    if (snapshot.truncated) state = { ...state, truncated: true };
    for (const child of snapshot.children) {
      for (const entry of child.history) {
        state = recordProviderChildObservation(state, {
          ...entry,
          instanceId: child.providerInstanceId,
          sessionId: child.sessionId,
          childAgentId: child.childAgentId,
          ...(child.parentChildAgentId === undefined
            ? {}
            : { parentChildAgentId: child.parentChildAgentId }),
          ...(child.modelId === undefined ? {} : { modelId: child.modelId }),
          ...(child.task === undefined ? {} : { task: child.task }),
        });
      }
      if (child.historyStatus !== "partial") {
        state = {
          ...state,
          children: state.children.map((item) =>
            sameChild(item, child) && item.historyStatus !== "conflicted"
              ? {
                  ...item,
                  historyStatus: child.historyStatus,
                  ...(child.historyStatus === "conflicted"
                    ? { lifecycleStatus: "unknown" as const }
                    : {}),
                }
              : item,
          ),
        };
      }
    }
  }
  for (const event of input.events ?? []) state = recordProviderChildObservation(state, event);
  const observations: AgentObservedChild[] = [];
  for (const child of state.children) {
    const seen = new Set<string>([child.childAgentId]);
    let parent = child.parentChildAgentId;
    let lineageKnown = true;
    while (parent !== undefined) {
      if (seen.has(parent)) {
        lineageKnown = false;
        break;
      }
      seen.add(parent);
      const ancestor = state.children.find(
        (candidate) =>
          candidate.childAgentId === parent &&
          candidate.providerInstanceId === child.providerInstanceId &&
          candidate.sessionId === child.sessionId,
      );
      if (ancestor === undefined || ancestor.historyStatus === "conflicted") {
        lineageKnown = false;
        break;
      }
      parent = ancestor.parentChildAgentId;
    }
    if (!lineageKnown) continue;
    observations.push({
      ...child,
      kind: "observed",
      control: "unavailable",
      mode: input.mode,
      parentThreadId: input.parentThreadId,
      ...(input.parentRunId === undefined ? {} : { parentRunId: input.parentRunId }),
      observationId: JSON.stringify([
        input.mode,
        input.parentThreadId,
        input.parentRunId ?? null,
        child.providerInstanceId,
        child.sessionId,
        child.childAgentId,
      ]),
    });
  }
  return { observations, observationsTruncated: state.truncated };
}

function sameChild(a: ProviderChildObservation, b: ProviderChildObservation): boolean {
  return (
    a.providerInstanceId === b.providerInstanceId &&
    a.sessionId === b.sessionId &&
    a.childAgentId === b.childAgentId
  );
}
