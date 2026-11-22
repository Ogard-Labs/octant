import type { OctantMode, ProjectId, WindowId } from "@octant/contracts";
import { authorizePrincipalAction } from "@octant/domain";
import { hubActRefusal, type HubActScopePort } from "../hub/hubActScope";
import type { ThreadMessageQueuePortDependencies } from "./threadMessageQueuePorts";

export interface ThreadMessageQueueAuthorityDependencies {
  readonly isLocalWindowLive: (scopeId: WindowId) => boolean;
  /** Whether a scope is a device still paired with this host. */
  readonly isPairedDevice: (scopeId: WindowId) => boolean;
  readonly localWindowCanAccess: (
    scopeId: WindowId,
    mode: OctantMode,
    projectId: ProjectId | undefined,
  ) => boolean;
  readonly projectType: (projectId: ProjectId) => OctantMode | undefined;
  readonly hasActiveCodeProject: (projectId: ProjectId) => boolean;
  /** Whether a paired device is one the host's own person did not pair, so the Act item holds it. */
  readonly isRestrictedDevice?: (scopeId: WindowId) => boolean;
  /** The member's Act item, read at each check; undefined while this host is in no hub. */
  readonly hubActScope?: () => HubActScopePort | undefined;
}

/** The catalogued action a paired device sends a turn under, per mode. */
const DEVICE_SEND_ACTION: Readonly<Record<OctantMode, string>> = {
  chat: "chat.send-turn",
  work: "work.update-document",
  code: "code.plan-turn",
};

/**
 * Whose authority a queued message may wait under. A local window keeps its
 * own rule. A paired device has no window and no workspace, so it is judged
 * as its own send would be: still paired, allowed the mode's send action, and
 * the thread's Project one that mode serves (for Code, an active one). The
 * queue asks at enqueue and again at every dispatch, so a device unpaired in
 * between holds nothing.
 */
export function createThreadMessageQueueAuthority(
  deps: ThreadMessageQueueAuthorityDependencies,
): Pick<ThreadMessageQueuePortDependencies, "isWindowLive" | "canAccess"> {
  return {
    isWindowLive: (scopeId) => deps.isLocalWindowLive(scopeId) || deps.isPairedDevice(scopeId),
    canAccess: (scopeId, mode, projectId) => {
      if (!deps.isPairedDevice(scopeId)) return deps.localWindowCanAccess(scopeId, mode, projectId);
      const decision = authorizePrincipalAction({
        principalKind: "remote-device",
        action: DEVICE_SEND_ACTION[mode],
      });
      if (decision.kind !== "allow") return false;
      if (mode === "chat") return projectId === undefined || deps.projectType(projectId) === "chat";
      if (projectId === undefined) return false;
      // A queued Code turn is held to the Act item as a sent one is, at
      // enqueue and at every dispatch; otherwise queueing would carry a
      // hub-introduced device's turn into a Project the item does not name.
      return mode === "code"
        ? deps.hasActiveCodeProject(projectId) &&
            (deps.isRestrictedDevice?.(scopeId) !== true ||
              hubActRefusal(deps.hubActScope?.(), String(projectId), "turn") === undefined)
        : deps.projectType(projectId) === "work";
    },
  };
}
