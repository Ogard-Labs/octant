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
   * windows, or an active device that person paired at the Full access level
   * (maintainer decisions, 2026-11-12 and 2026-11-22). A device the hub's
   * roster introduced, one the person paired below Full, a revoked or expired
   * device, and an id nobody registered are not.
   */
  readonly actsAsHostPerson: (scopeId: WindowId) => boolean;
  /**
   * The device a change made under the scope is journaled as, when the scope
   * is a device the person paired, at any access level. Undefined for a window,
   * whose change is the local person's.
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
  /** Whether the host's record gives the device the Full access level; only Full is the person. */
  readonly hasFullAccess: (deviceId: string) => boolean;
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
    actsAsHostPerson: (scopeId) =>
      isLocalWindow(scopeId) ||
      (isPersonPairedDevice(scopeId) && options.hasFullAccess(String(scopeId))),
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

/**
 * Whether a paired device's scope is held to less than the host's own person:
 * one the hub introduced or whose approval is unproved, or one the person
 * paired below the Full access level. A scope that is no paired device (a
 * window, the host) is never restricted by this.
 */
export function createRestrictedDeviceScope(options: {
  readonly isPairedDeviceScope: (scopeId: WindowId) => boolean;
  readonly approvedByPerson: (deviceId: string) => boolean;
  readonly hasFullAccess: (deviceId: string) => boolean;
}): (scopeId: WindowId) => boolean {
  return (scopeId) =>
    options.isPairedDeviceScope(scopeId) &&
    (!options.approvedByPerson(String(scopeId)) || !options.hasFullAccess(String(scopeId)));
}
