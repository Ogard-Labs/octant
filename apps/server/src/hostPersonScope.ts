import type { EventActor, WindowId } from "@octant/contracts";
import { eventActorForPrincipal } from "./principalEventActor";

/**
 * What a service that takes only a scope id knows about who is behind it. A
 * route resolves the scope from the authenticated principal: a window's own
 * id, or a paired device's id.
 */
export interface HostPersonScopes {
  /**
   * Whether the scope is the host's own person: one of this host's live
   * windows, or an active device that person paired (maintainer decision,
   * 2026-11-12). A device the hub's roster introduced, a revoked or expired
   * device, and an id nobody registered are not.
   */
  readonly actsAsHostPerson: (scopeId: WindowId) => boolean;
  /**
   * The device a change made under the scope is journaled as, when the scope
   * is a device the person paired. Undefined for a window, whose change is the
   * local person's.
   */
  readonly deviceActor: (scopeId: WindowId) => EventActor | undefined;
}

export function createHostPersonScopes(options: {
  readonly localWindows: () => ReadonlyArray<WindowId>;
  /** The host's own device registrations, read at each question so a revoke applies at once. */
  readonly devices: () => ReadonlyArray<{
    readonly device_id: string;
    readonly state: "active" | "revoked" | "expired";
  }>;
  /** Whether the host's approval record for the device says its person approved it. */
  readonly approvedByPerson: (deviceId: string) => boolean;
}): HostPersonScopes {
  const isLocalWindow = (scopeId: WindowId): boolean =>
    options.localWindows().some((windowId) => String(windowId) === String(scopeId));
  const isPersonPairedDevice = (scopeId: WindowId): boolean => {
    const deviceId = String(scopeId);
    return (
      options
        .devices()
        .some((device) => String(device.device_id) === deviceId && device.state === "active") &&
      options.approvedByPerson(deviceId)
    );
  };
  return {
    actsAsHostPerson: (scopeId) => isLocalWindow(scopeId) || isPersonPairedDevice(scopeId),
    deviceActor: (scopeId) =>
      !isLocalWindow(scopeId) && isPersonPairedDevice(scopeId)
        ? eventActorForPrincipal({ kind: "remote-device", deviceId: String(scopeId) })
        : undefined,
  };
}

/**
 * Whether a scope reaches a Project to review what was granted there. A
 * window reaches the Project its workspace is bound to. A device the person
 * paired has no workspace on the host (no remote request makes one), so asked
 * the window's question it reached nothing and was shown no review targets;
 * it reaches every active Project, as it does when it opens a thread there.
 */
export function createPersonProjectReach<ProjectRef, Mode>(options: {
  readonly windowHoldsProject: (scopeId: WindowId, projectId: ProjectRef, mode: Mode) => boolean;
  readonly isPersonPairedDevice: (scopeId: WindowId) => boolean;
  readonly isActiveProject: (projectId: ProjectRef, mode: Mode) => boolean;
}): (scopeId: WindowId, projectId: ProjectRef, mode: Mode) => boolean {
  return (scopeId, projectId, mode) =>
    options.windowHoldsProject(scopeId, projectId, mode) ||
    (options.isPersonPairedDevice(scopeId) && options.isActiveProject(projectId, mode));
}
