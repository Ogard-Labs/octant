import {
  decodeCodeThreadId,
  decodeWorkThreadId,
  type CodeThreadId,
  type ProjectId,
  type WorkThreadId,
} from "@octant/contracts";
import { decideHubIntroducedAct, type HubIntroducedActDecision } from "@octant/domain";
import type { SpokeLinkStatus } from "./spokeLinkService";

/** What a member's grant to its hub lets a device only the hub introduced do in a Project here. */
export interface HubActScopePort {
  readonly decide: (projectId: string) => HubIntroducedActDecision;
}

export interface HubActScopeSlot {
  readonly current: () => HubActScopePort | undefined;
  readonly bind: (port: HubActScopePort) => void;
}

/**
 * The routes that read the Act item are built before the hub side, which
 * binds the member's Act item here once its spoke link exists.
 */
export function createHubActScopeSlot(): HubActScopeSlot {
  let bound: HubActScopePort | undefined;
  return {
    current: () => bound,
    bind: (port) => {
      bound = port;
    },
  };
}

/** Reads the member's grant at each request, so a changed Act item governs the next one. */
export function hubActScopeFromSpokeLink(spoke: {
  readonly status: () => SpokeLinkStatus;
}): HubActScopePort {
  return {
    decide: (projectId) => {
      const status = spoke.status();
      return decideHubIntroducedAct({
        membership: status.membership,
        grant: status.membership === "none" ? undefined : status.grant,
        projectId,
      });
    },
  };
}

/** The three things the Act item lets such a device do in a Project it names. */
export type HubActAction = "start" | "answer" | "stop";

const ACTION_WORDS: Readonly<Record<HubActAction, string>> = {
  start: "start threads",
  answer: "answer approvals or questions",
  stop: "stop turns",
};

/** The sentence a refused request shows, naming what the member would change. */
function hubActRefusalMessage(
  decision: Extract<HubIntroducedActDecision, { readonly status: "refused" }>,
  action: HubActAction,
): string {
  switch (decision.kind) {
    case "removed-from-hub":
      return `This computer has left its hub, so a device the hub introduced cannot ${ACTION_WORDS[action]} here.`;
    case "act-not-granted":
      return `This computer has not ticked Act for its hub, so a device the hub introduced cannot ${ACTION_WORDS[action]} here.`;
    case "project-not-named":
      return "This computer's Act item for its hub does not name this Project.";
  }
}

/**
 * The sentence refusing what a device only the hub introduced asked to do in a
 * Project, or undefined when the member's Act item allows it or this host is in
 * no hub. The server always binds the scope with its hub side, so a route built
 * without one belongs to no hub. A Project the route could not find is no
 * Project the item names, so it is refused while this host is in a hub.
 */
export function hubActRefusal(
  scope: HubActScopePort | undefined,
  projectId: string | undefined,
  action: HubActAction,
): string | undefined {
  const decision = scope?.decide(projectId ?? "");
  return decision?.status === "refused" ? hubActRefusalMessage(decision, action) : undefined;
}

/**
 * The Project of a Code or Work thread, for a route that answers a prompt
 * naming only its thread. Undefined for any other thread, such as a Chat
 * thread, and for an id that names no thread here.
 */
export function codeOrWorkThreadProjectId(sources: {
  readonly readCodeThread: (
    threadId: CodeThreadId,
  ) => { readonly projectId: ProjectId } | undefined;
  readonly readWorkThread: (
    threadId: WorkThreadId,
  ) => { readonly projectId: ProjectId } | undefined;
}): (threadId: string) => string | undefined {
  return (threadId) => {
    try {
      const projectId =
        sources.readCodeThread(decodeCodeThreadId(threadId))?.projectId ??
        sources.readWorkThread(decodeWorkThreadId(threadId))?.projectId;
      return projectId === undefined ? undefined : String(projectId);
    } catch {
      return undefined;
    }
  };
}
