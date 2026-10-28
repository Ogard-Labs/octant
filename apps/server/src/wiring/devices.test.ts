import { decodeAppleDeviceRequest, type WindowId } from "@octant/contracts";
import { describe, expect, it, vi } from "vitest";
import { createAppleDeviceScopes } from "./devices";

const windowId = "50000000-0000-4000-8000-000000000001" as WindowId;
const threadId = "50000000-0000-4000-8000-000000000020";
const checkoutId = "50000000-0000-4000-8000-000000000021";
const authority = {
  hostId: "50000000-0000-4000-8000-000000000002",
  mode: "code",
  projectId: "50000000-0000-4000-8000-000000000003",
  providerInstanceId: "50000000-0000-4000-8000-000000000004",
  extension: { kind: "core" },
} as const;
const agent = {
  kind: "agent",
  actorId: "50000000-0000-4000-8000-000000000010",
  providerInstanceId: authority.providerInstanceId,
  threadId,
} as const;

function leaseRequest(requestedBy: unknown) {
  return decodeAppleDeviceRequest({
    actionId: "50000000-0000-4000-8000-000000000030",
    correlationId: "50000000-0000-4000-8000-000000000031",
    authority,
    threadId,
    checkoutId,
    kind: "use-device",
    deviceId: "50000000-0000-4000-8000-000000000040",
    requestedBy,
    timeoutMs: 30_000,
    approval: { kind: "approved", approvalId: "50000000-0000-4000-8000-000000000050" },
  });
}

function scopes() {
  const thread = { id: threadId, checkoutId, executionPolicy: "approval-gated" } as never;
  const resolveThread = vi.fn(async () => ({
    thread,
    checkout: { id: checkoutId } as never,
    rootPath: "/private/checkout",
  }));
  const validateAppleDeviceLease = vi.fn(async () => true);
  const validateAppleDeviceAction = vi.fn(async () => true);
  const validateAppleDistributionUpload = vi.fn(async () => true);
  return {
    resolveThread,
    validateAppleDeviceLease,
    validateAppleDistributionUpload,
    ...createAppleDeviceScopes({
      resolveThread,
      effectiveThread: (_windowId, current) => current,
      approvals: {
        validateAppleDeviceLease,
        validateAppleDeviceAction,
        validateAppleDistributionUpload,
      },
    }),
  };
}

describe("the agent's physical device scope", () => {
  it.each([
    ["a person at the Mac", { kind: "local-user", actorId: agent.actorId }],
    [
      "a paired device",
      {
        kind: "remote-device",
        actorId: agent.actorId,
        deviceId: "50000000-0000-4000-8000-000000000060",
      },
    ],
  ])("refuses a request that speaks for %s, before any receipt is read", async (_name, actor) => {
    const { resolveAppleDeviceAgentScope, resolveThread, validateAppleDeviceLease } = scopes();

    await expect(
      resolveAppleDeviceAgentScope(windowId, leaseRequest(actor)),
    ).resolves.toBeUndefined();
    expect(resolveThread).not.toHaveBeenCalled();
    expect(validateAppleDeviceLease).not.toHaveBeenCalled();
  });

  it("counts the agent's lease as a local person's confirmation only with a receipt that validates", async () => {
    const { resolveAppleDeviceAgentScope, validateAppleDeviceLease } = scopes();
    const request = leaseRequest(agent);

    await expect(resolveAppleDeviceAgentScope(windowId, request)).resolves.toMatchObject({
      approvalValid: true,
      approvedBy: { kind: "local-user" },
    });
    expect(validateAppleDeviceLease).toHaveBeenCalledWith(windowId, request);

    validateAppleDeviceLease.mockResolvedValueOnce(false);
    const unconfirmed = await resolveAppleDeviceAgentScope(windowId, request);
    expect(unconfirmed).toMatchObject({ approvalValid: false });
    expect(unconfirmed).not.toHaveProperty("approvedBy");
  });

  it("counts the agent's upload as confirmed only with the receipt a person at the Mac minted for that build", async () => {
    const { resolveAppleDeviceAgentScope, validateAppleDistributionUpload } = scopes();
    const request = decodeAppleDeviceRequest({
      actionId: "50000000-0000-4000-8000-000000000032",
      correlationId: "50000000-0000-4000-8000-000000000033",
      authority,
      threadId,
      checkoutId,
      kind: "upload",
      requestedBy: agent,
      projectPath: "App.xcodeproj",
      teamId: "A1B2C3D4E5",
      upload: {
        bundleIdentifier: "sh.octant.Fixture",
        version: "1.0",
        buildNumber: "7",
        signing: { teamId: "A1B2C3D4E5", identity: "3".repeat(40) },
        profileId: "50000000-0000-4000-8000-000000000070",
      },
      timeoutMs: 60_000,
      approval: { kind: "approved", approvalId: "50000000-0000-4000-8000-000000000051" },
    });

    await expect(resolveAppleDeviceAgentScope(windowId, request)).resolves.toMatchObject({
      approvalValid: true,
      approvedBy: { kind: "local-user" },
    });
    expect(validateAppleDistributionUpload).toHaveBeenCalledWith(windowId, request);

    validateAppleDistributionUpload.mockResolvedValueOnce(false);
    const unconfirmed = await resolveAppleDeviceAgentScope(windowId, request);
    expect(unconfirmed).toMatchObject({ approvalValid: false });
    expect(unconfirmed).not.toHaveProperty("approvedBy");
  });
});
