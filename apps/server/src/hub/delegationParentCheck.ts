import type { PeerDelegationMode } from "@octant/contracts";
import type { AgentRunControlParentFacts } from "../agentRun/agentRunControlService";
import type { ParentCheck } from "./delegatingSpokeService";

/** The parent facts the rules read; the host's full facts satisfy it. */
export interface DelegationParentFacts {
  readonly parentMode: AgentRunControlParentFacts["parentMode"];
  readonly parentAuthority: Pick<AgentRunControlParentFacts["parentAuthority"], "subagents">;
  readonly liveAuthority: Pick<
    AgentRunControlParentFacts["liveAuthority"],
    "subagents" | "executionPolicy"
  >;
}

export interface DelegationParentRules {
  readonly creationPosture: () => "off" | "ask" | "automatic";
  readonly authorizeCreation: (input: {
    readonly threadId: string;
    readonly windowId: string;
  }) => DelegationParentFacts | undefined;
  readonly externalContentIngested: (threadId: string) => boolean;
  readonly sessionStatus: (threadId: string) => string | undefined;
}

/**
 * A paused session, or one a restart left needing a check, starts no helper
 * until it is resumed. The local helper path refuses by the same statuses.
 */
export function harnessSessionHoldsHelpers(status: string | undefined): boolean {
  return (
    status === "paused-by-user" || status === "paused-by-advisor" || status === "recovery-required"
  );
}

/**
 * This host's own rules for a parent thread that wants to start a child on
 * another host: the same rules a helper started here meets.
 */
export function checkDelegationParent(
  rules: DelegationParentRules,
  input: {
    readonly mode: PeerDelegationMode;
    readonly threadId: string;
    readonly windowId: string;
  },
): ParentCheck {
  if (rules.creationPosture() !== "automatic") {
    return { status: "refused", kind: "subagents-off" };
  }
  const parent = rules.authorizeCreation({ threadId: input.threadId, windowId: input.windowId });
  if (parent === undefined) return { status: "refused", kind: "parent-unavailable" };
  if (parent.parentMode !== input.mode) return { status: "refused", kind: "parent-mode-mismatch" };
  if (!parent.parentAuthority.subagents || !parent.liveAuthority.subagents) {
    return { status: "refused", kind: "subagents-not-allowed" };
  }
  // A thread that read outside content cannot start helpers, and a
  // delegated result is outside content.
  if (rules.externalContentIngested(input.threadId)) {
    return { status: "refused", kind: "parent-tainted" };
  }
  if (harnessSessionHoldsHelpers(rules.sessionStatus(input.threadId))) {
    return { status: "refused", kind: "session-paused" };
  }
  const policy = parent.liveAuthority.executionPolicy;
  return {
    status: "allowed",
    ceiling:
      policy === "full-access" ? "full-access" : policy === "plan" ? "plan" : "approval-gated",
  };
}
