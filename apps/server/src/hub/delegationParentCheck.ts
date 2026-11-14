import type { PeerDelegationMode } from "@octant/contracts";
import { outsideContentRefusesDelegation } from "@octant/domain/untrusted-content-policy";
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
  /**
   * Whether the parent runs at Full access: its running turn's level, else the
   * thread's own. The parent facts cannot say: a Work parent's child ceiling
   * is approval-gated whatever the thread's level.
   */
  readonly runsAtFullAccess: (threadId: string) => boolean;
  /**
   * Whether the person answered for this thread, after it read outside
   * content, that it may start helpers: the same `delegation` answer a helper
   * on this host asks for, so one answer covers both kinds of helper.
   */
  readonly standingAnswerCovers: (threadId: string) => boolean;
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
  const policy = parent.liveAuthority.executionPolicy;
  // Below Full access a thread that read outside content (a delegated result
  // counts) starts a helper on another host only once its person has answered
  // for the thread, as a helper on this host does. The agent's tool call asks
  // before reaching here; Plan has no ask, so it stays refused.
  if (
    outsideContentRefusesDelegation({
      externalContentIngested: rules.externalContentIngested(input.threadId),
      fullAccessThread: rules.runsAtFullAccess(input.threadId),
    }) &&
    !rules.standingAnswerCovers(input.threadId)
  ) {
    return { status: "refused", kind: "parent-tainted" };
  }
  if (harnessSessionHoldsHelpers(rules.sessionStatus(input.threadId))) {
    return { status: "refused", kind: "session-paused" };
  }
  return {
    status: "allowed",
    ceiling:
      policy === "full-access" ? "full-access" : policy === "plan" ? "plan" : "approval-gated",
  };
}
