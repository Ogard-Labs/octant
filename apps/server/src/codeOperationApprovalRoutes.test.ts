import {
  decodeCodeOperationApprovalChallenge,
  decodeCodeOperationApprovalReceipt,
  decodeWindowId,
} from "@octant/contracts";
import { describe, expect, it, vi } from "vitest";
import { createCodeOperationApprovalRouteHandler } from "./codeOperationApprovalRoutes";
import { CodeOperationApprovalUnavailableError } from "./code/codeOperationApprovalStore";
import { WindowAuthorityStore } from "./windowAuthorityStore";

const secret = "desktop-secret";
const capability = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const windowId = decodeWindowId("10000000-0000-4000-8000-000000000001");
const request = {
  effect: {
    kind: "operation",
    command: {
      kind: "start-terminal",
      threadId: "20000000-0000-4000-8000-000000000001",
      checkoutId: "30000000-0000-4000-8000-000000000001",
      operationId: "40000000-0000-4000-8000-000000000001",
      terminalId: "60000000-0000-4000-8000-000000000001",
      columns: 100,
      rows: 30,
      credentialRefs: [],
    },
  },
} as const;
const receipt = decodeCodeOperationApprovalReceipt({
  approvalId: "50000000-0000-4000-8000-000000000001",
});
const challenge = decodeCodeOperationApprovalChallenge({
  challengeId: "70000000-0000-4000-8000-000000000001",
  effectDigest: "a".repeat(64),
  contextDigest: "b".repeat(64),
  projectId: "80000000-0000-4000-8000-000000000001",
  threadId: request.effect.command.threadId,
  threadTitle: "Fix login",
  checkoutId: request.effect.command.checkoutId,
  repositoryId: `repo_${"c".repeat(64)}`,
  checkoutHead: { kind: "branch", name: "feature/phase-7", oid: "d".repeat(40) },
  message: "Allow terminal access?",
  detail: "Authoritative scope",
});

function fixture() {
  const authority = new WindowAuthorityStore();
  authority.register({ windowId, capability, now: 1_000 });
  const prepare = vi.fn(async () => challenge);
  const confirm = vi.fn(async () => receipt);
  return {
    prepare,
    confirm,
    handle: createCodeOperationApprovalRouteHandler({
      desktopBridgeSecret: secret,
      windowAuthorityStore: authority,
      prepare,
      confirm,
      now: () => 1_001,
    }),
  };
}

describe("Code operation approval route", () => {
  it("requires both native-host and exact window authority before issuing a receipt", async () => {
    const { prepare, confirm, handle } = fixture();
    const response = await handle(
      new Request("http://127.0.0.1/api/desktop/code-operation-approval-challenges", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-octant-desktop-secret": secret,
          "x-octant-window-capability": capability,
        },
        body: JSON.stringify(request),
      }),
    );
    expect(response?.status).toBe(201);
    await expect(response?.json()).resolves.toEqual(challenge);
    expect(prepare).toHaveBeenCalledWith(windowId, request);

    const confirmation = await handle(
      new Request("http://127.0.0.1/api/desktop/code-operation-approval-confirmations", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-octant-desktop-secret": secret,
          "x-octant-window-capability": capability,
        },
        body: JSON.stringify({ challengeId: challenge.challengeId }),
      }),
    );
    await expect(confirmation?.json()).resolves.toEqual(receipt);
    expect(confirm).toHaveBeenCalledWith(windowId, { challengeId: challenge.challengeId });
  });

  it("fails closed for renderer-origin, missing host secret, invalid bodies, and denied scope", async () => {
    const { prepare, handle } = fixture();
    for (const candidate of [
      new Request("http://127.0.0.1/api/desktop/code-operation-approval-challenges", {
        method: "POST",
        headers: {
          origin: "file://renderer",
          "content-type": "application/json",
          "x-octant-desktop-secret": secret,
          "x-octant-window-capability": capability,
        },
        body: JSON.stringify(request),
      }),
      new Request("http://127.0.0.1/api/desktop/code-operation-approval-challenges", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-octant-window-capability": capability,
        },
        body: JSON.stringify(request),
      }),
      new Request("http://127.0.0.1/api/desktop/code-operation-approval-challenges", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-octant-desktop-secret": secret,
          "x-octant-window-capability": capability,
        },
        body: JSON.stringify({ effect: { kind: "operation", command: { kind: "observe-git" } } }),
      }),
    ]) {
      expect((await handle(candidate))?.status).not.toBe(201);
    }
    expect(prepare).not.toHaveBeenCalled();

    const denied = createCodeOperationApprovalRouteHandler({
      desktopBridgeSecret: secret,
      windowAuthorityStore: new WindowAuthorityStore(),
      prepare: vi.fn(async () => undefined),
      confirm: vi.fn(async () => undefined),
      now: () => 1_001,
    });
    expect(
      (
        await denied(
          new Request("http://127.0.0.1/api/desktop/code-operation-approval-challenges", {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-octant-desktop-secret": secret,
              "x-octant-window-capability": capability,
            },
            body: JSON.stringify(request),
          }),
        )
      )?.status,
    ).toBe(401);
  });

  it("reports host-time recovery as an actionable unavailable response", async () => {
    const authority = new WindowAuthorityStore();
    authority.register({ windowId, capability, now: 1_000 });
    const handle = createCodeOperationApprovalRouteHandler({
      desktopBridgeSecret: secret,
      windowAuthorityStore: authority,
      prepare: async () => {
        throw new CodeOperationApprovalUnavailableError();
      },
      confirm: async () => receipt,
      now: () => 1_001,
    });

    const response = await handle(
      new Request("http://127.0.0.1/api/desktop/code-operation-approval-challenges", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-octant-desktop-secret": secret,
          "x-octant-window-capability": capability,
        },
        body: JSON.stringify(request),
      }),
    );

    expect(response?.status).toBe(503);
    await expect(response?.json()).resolves.toEqual({
      category: "unavailable",
      message: "Code operation approval is unavailable while host time recovery is required.",
    });

    const confirmationHandle = createCodeOperationApprovalRouteHandler({
      desktopBridgeSecret: secret,
      windowAuthorityStore: authority,
      prepare: async () => challenge,
      confirm: async () => {
        throw new CodeOperationApprovalUnavailableError();
      },
      now: () => 1_001,
    });
    const confirmation = await confirmationHandle(
      new Request("http://127.0.0.1/api/desktop/code-operation-approval-confirmations", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-octant-desktop-secret": secret,
          "x-octant-window-capability": capability,
        },
        body: JSON.stringify({ challengeId: challenge.challengeId }),
      }),
    );
    expect(confirmation?.status).toBe(503);
  });
});
