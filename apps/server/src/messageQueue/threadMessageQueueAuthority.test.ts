import { decodeProjectId, decodeWindowId } from "@octant/contracts";
import { describe, expect, it } from "vitest";
import { hubActScopeFromSpokeLink } from "../hub/hubActScope";
import { createThreadMessageQueueAuthority } from "./threadMessageQueueAuthority";

const windowId = decodeWindowId("93000000-0000-4000-8000-000000000001");
const deviceId = decodeWindowId("93000000-0000-4000-8000-000000000002");
const chatProject = decodeProjectId("93000000-0000-4000-8000-000000000010");
const workProject = decodeProjectId("93000000-0000-4000-8000-000000000011");
const codeProject = decodeProjectId("93000000-0000-4000-8000-000000000012");

function setup(overrides: { readonly paired?: () => boolean } = {}) {
  const paired = overrides.paired ?? (() => true);
  return createThreadMessageQueueAuthority({
    isLocalWindowLive: (id) => String(id) === String(windowId),
    isPairedDevice: (id) => paired() && String(id) === String(deviceId),
    deviceAccessLevel: () => "full",
    localWindowCanAccess: (id) => String(id) === String(windowId),
    projectType: (id) =>
      id === chatProject
        ? "chat"
        : id === workProject
          ? "work"
          : id === codeProject
            ? "code"
            : undefined,
    hasActiveCodeProject: (id) => id === codeProject,
  });
}

describe("who a queued message may wait for", () => {
  it("holds a hub-introduced device's queued Code turn to the Projects the member's Act item names", () => {
    const named = decodeProjectId("93000000-0000-4000-8000-000000000013");
    const authority = createThreadMessageQueueAuthority({
      isLocalWindowLive: () => false,
      isPairedDevice: (id) => String(id) === String(deviceId),
      deviceAccessLevel: () => undefined,
      localWindowCanAccess: () => false,
      projectType: () => "code",
      hasActiveCodeProject: () => true,
      isRestrictedDevice: (id) => String(id) === String(deviceId),
      hubActScope: () =>
        hubActScopeFromSpokeLink({
          status: () =>
            ({
              membership: "member",
              grant: { items: ["roster", "introduce", "act"], actProjects: [named] },
            }) as never,
        }),
    });
    // Asked at enqueue and again before each dispatch.
    expect(authority.canAccess(deviceId, "code", named, "dispatch")).toBe(true);
    expect(authority.canAccess(deviceId, "code", codeProject, "dispatch")).toBe(false);
  });

  it("lets a paired device queue on the threads it may already send to", () => {
    const authority = setup();
    expect(authority.isWindowLive(deviceId)).toBe(true);
    expect(authority.canAccess(deviceId, "chat", undefined, "dispatch")).toBe(true);
    expect(authority.canAccess(deviceId, "chat", chatProject, "dispatch")).toBe(true);
    expect(authority.canAccess(deviceId, "work", workProject, "dispatch")).toBe(true);
    expect(authority.canAccess(deviceId, "code", codeProject, "dispatch")).toBe(true);
  });

  it("refuses a device a thread outside its mode's Projects", () => {
    const authority = setup();
    expect(authority.canAccess(deviceId, "chat", workProject, "dispatch")).toBe(false);
    expect(authority.canAccess(deviceId, "work", undefined, "dispatch")).toBe(false);
    expect(authority.canAccess(deviceId, "work", codeProject, "dispatch")).toBe(false);
    expect(authority.canAccess(deviceId, "code", undefined, "dispatch")).toBe(false);
    expect(authority.canAccess(deviceId, "code", workProject, "dispatch")).toBe(false);
  });

  it("stops holding for a device the moment its pairing ends", () => {
    let paired = true;
    const authority = setup({ paired: () => paired });
    expect(authority.isWindowLive(deviceId)).toBe(true);
    paired = false;
    expect(authority.isWindowLive(deviceId)).toBe(false);
    expect(authority.canAccess(deviceId, "chat", undefined, "dispatch")).toBe(false);
    expect(authority.canAccess(deviceId, "code", codeProject, "dispatch")).toBe(false);
  });

  it("keeps a local window on its own rule and gives an unknown scope nothing", () => {
    const authority = setup();
    const stranger = decodeWindowId("93000000-0000-4000-8000-000000000003");
    expect(authority.isWindowLive(windowId)).toBe(true);
    expect(authority.canAccess(windowId, "work", workProject, "dispatch")).toBe(true);
    expect(authority.isWindowLive(stranger)).toBe(false);
    expect(authority.canAccess(stranger, "chat", undefined, "dispatch")).toBe(false);
  });
});
