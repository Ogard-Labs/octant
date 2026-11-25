import { decodeWindowId } from "@octant/contracts";
import { describe, expect, it } from "vitest";
import {
  createHostPersonScopes,
  createPersonProjectReach,
  createRestrictedDeviceScope,
} from "./hostPersonScope";

const windowId = decodeWindowId("10000000-0000-4000-8000-000000000001");
const personPaired = decodeWindowId("20000000-0000-4000-8000-000000000001");
const hubIntroduced = decodeWindowId("20000000-0000-4000-8000-000000000002");
const revoked = decodeWindowId("20000000-0000-4000-8000-000000000003");
const unknown = decodeWindowId("20000000-0000-4000-8000-000000000004");
const belowFull = decodeWindowId("20000000-0000-4000-8000-000000000005");

function scopes() {
  return createHostPersonScopes({
    localWindows: () => [windowId],
    devices: () => [
      { device_id: String(personPaired), state: "active" },
      { device_id: String(hubIntroduced), state: "active" },
      { device_id: String(revoked), state: "revoked" },
      { device_id: String(belowFull), state: "active" },
    ],
    approvedByPerson: (deviceId) => deviceId !== String(hubIntroduced),
    hasFullAccess: (deviceId) => deviceId !== String(belowFull),
  });
}

describe("the scopes that act as the host's own person", () => {
  it("passes a live window and an active device the person paired, and no other scope", () => {
    const { actsAsHostPerson } = scopes();
    expect(actsAsHostPerson(windowId)).toBe(true);
    expect(actsAsHostPerson(personPaired)).toBe(true);
    // The hub's roster introduced it, the person revoked it, nobody knows it.
    expect(actsAsHostPerson(hubIntroduced)).toBe(false);
    expect(actsAsHostPerson(revoked)).toBe(false);
    expect(actsAsHostPerson(unknown)).toBe(false);
    // The person paired it below Full: it is a device they trust, not them.
    expect(actsAsHostPerson(belowFull)).toBe(false);
  });

  it("names the device for a person-paired device's scope, and no device for a window or any other scope", () => {
    const { deviceActor } = scopes();
    expect(deviceActor(personPaired)).toEqual({
      kind: "remote-device",
      actorId: String(personPaired),
      deviceId: String(personPaired),
    });
    // A device below Full is still the actor of what it is allowed to do.
    expect(deviceActor(belowFull)).toMatchObject({ deviceId: String(belowFull) });
    expect(deviceActor(windowId)).toBeUndefined();
    expect(deviceActor(hubIntroduced)).toBeUndefined();
    expect(deviceActor(revoked)).toBeUndefined();
  });

  it("restricts every paired device but one the person paired at Full, and never a window", () => {
    const isRestricted = createRestrictedDeviceScope({
      isPairedDeviceScope: (scopeId) => String(scopeId) !== String(windowId),
      approvedByPerson: (deviceId) => deviceId !== String(hubIntroduced),
      hasFullAccess: (deviceId) => deviceId !== String(belowFull),
    });
    expect(isRestricted(belowFull)).toBe(true);
    expect(isRestricted(hubIntroduced)).toBe(true);
    expect(isRestricted(personPaired)).toBe(false);
    expect(isRestricted(windowId)).toBe(false);
  });

  it("lets a person-paired device review every active Project, though no workspace on the host is bound for it", () => {
    const { deviceActor } = scopes();
    const reaches = createPersonProjectReach({
      windowHoldsProject: (scopeId, projectId) =>
        String(scopeId) === String(windowId) && projectId === "bound",
      isPersonPairedDevice: (scopeId) => deviceActor(scopeId) !== undefined,
      isActiveProject: (projectId) => projectId !== "archived",
    });
    expect(reaches(windowId, "bound", "code")).toBe(true);
    expect(reaches(windowId, "other", "code")).toBe(false);
    expect(reaches(personPaired, "other", "code")).toBe(true);
    expect(reaches(personPaired, "archived", "work")).toBe(false);
    // A roster member has no workspace and is not the person: it reviews nothing.
    expect(reaches(hubIntroduced, "bound", "code")).toBe(false);
    expect(reaches(revoked, "other", "code")).toBe(false);
  });
});
