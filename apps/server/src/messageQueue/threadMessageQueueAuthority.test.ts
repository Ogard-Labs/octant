import { decodeProjectId, decodeWindowId } from "@octant/contracts";
import { describe, expect, it } from "vitest";
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
  it("lets a paired device queue on the threads it may already send to", () => {
    const authority = setup();
    expect(authority.isWindowLive(deviceId)).toBe(true);
    expect(authority.canAccess(deviceId, "chat", undefined)).toBe(true);
    expect(authority.canAccess(deviceId, "chat", chatProject)).toBe(true);
    expect(authority.canAccess(deviceId, "work", workProject)).toBe(true);
    expect(authority.canAccess(deviceId, "code", codeProject)).toBe(true);
  });

  it("refuses a device a thread outside its mode's Projects", () => {
    const authority = setup();
    expect(authority.canAccess(deviceId, "chat", workProject)).toBe(false);
    expect(authority.canAccess(deviceId, "work", undefined)).toBe(false);
    expect(authority.canAccess(deviceId, "work", codeProject)).toBe(false);
    expect(authority.canAccess(deviceId, "code", undefined)).toBe(false);
    expect(authority.canAccess(deviceId, "code", workProject)).toBe(false);
  });

  it("stops holding for a device the moment its pairing ends", () => {
    let paired = true;
    const authority = setup({ paired: () => paired });
    expect(authority.isWindowLive(deviceId)).toBe(true);
    paired = false;
    expect(authority.isWindowLive(deviceId)).toBe(false);
    expect(authority.canAccess(deviceId, "chat", undefined)).toBe(false);
    expect(authority.canAccess(deviceId, "code", codeProject)).toBe(false);
  });

  it("keeps a local window on its own rule and gives an unknown scope nothing", () => {
    const authority = setup();
    const stranger = decodeWindowId("93000000-0000-4000-8000-000000000003");
    expect(authority.isWindowLive(windowId)).toBe(true);
    expect(authority.canAccess(windowId, "work", workProject)).toBe(true);
    expect(authority.isWindowLive(stranger)).toBe(false);
    expect(authority.canAccess(stranger, "chat", undefined)).toBe(false);
  });
});
