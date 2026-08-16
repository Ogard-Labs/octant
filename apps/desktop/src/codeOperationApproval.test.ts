import { describe, expect, it, vi } from "vitest";
import { decodeCodeOperationApprovalRequest } from "@octant/contracts";
import {
  CodeOperationApprovalUnavailableError,
  requestCodeOperationApprovalFromServer,
} from "./codeOperationApproval";

const approvalThreadId = "10000000-0000-4000-8000-000000000001";
const approvalCheckoutId = "20000000-0000-4000-8000-000000000001";
const request = decodeCodeOperationApprovalRequest({
  effect: {
    kind: "operation",
    command: {
      kind: "start-terminal",
      threadId: approvalThreadId,
      checkoutId: approvalCheckoutId,
      operationId: "30000000-0000-4000-8000-000000000001",
      terminalId: "60000000-0000-4000-8000-000000000001",
      columns: 100,
      rows: 30,
      credentialRefs: [],
    },
  },
});

describe("native Code operation approval", () => {
  it("shows a cancel-default server-validated challenge before redeeming a scoped receipt", async () => {
    const showMessageBox = vi.fn(async () => ({ response: 0 }));
    const fetch = vi.fn(async (url: string | URL, init: RequestInit) => {
      expect(init.headers).toEqual({
        "content-type": "application/json",
        "x-octant-desktop-secret": "desktop-secret",
        "x-octant-window-capability": "window-capability",
      });
      if (String(url).endsWith("/api/desktop/code-operation-approval-challenges")) {
        expect(showMessageBox).not.toHaveBeenCalled();
        expect(JSON.parse(String(init.body))).toEqual(request);
        return Response.json(
          {
            challengeId: "50000000-0000-4000-8000-000000000001",
            effectDigest: "a".repeat(64),
            contextDigest: "b".repeat(64),
            projectId: "70000000-0000-4000-8000-000000000001",
            threadId: approvalThreadId,
            threadTitle: "Fix login",
            checkoutId: approvalCheckoutId,
            repositoryId: `repo_${"c".repeat(64)}`,
            checkoutHead: {
              kind: "branch",
              name: "feature/phase-7",
              oid: "d".repeat(40),
            },
            message: "Allow terminal access?",
            detail:
              "Project: authoritative\nThread: Fix login\nStart repository terminal (100 × 30)",
          },
          { status: 201 },
        );
      }
      expect(JSON.parse(String(init.body))).toEqual({
        challengeId: "50000000-0000-4000-8000-000000000001",
      });
      return Response.json(
        {
          approvalId: "40000000-0000-4000-8000-000000000001",
        },
        { status: 201 },
      );
    });
    await expect(
      requestCodeOperationApprovalFromServer({
        serverUrl: "http://127.0.0.1:13773/",
        desktopBridgeSecret: "desktop-secret",
        windowCapability: "window-capability",
        request,
        owner: {},
        dialog: { showMessageBox },
        fetch: fetch as never,
      }),
    ).resolves.toBe("40000000-0000-4000-8000-000000000001");
    expect(showMessageBox).toHaveBeenCalledWith(
      {},
      expect.objectContaining({
        cancelId: 1,
        defaultId: 1,
        detail: expect.stringContaining("Project: authoritative"),
      }),
    );
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("does not redeem a server challenge when the user cancels and sanitizes server failures", async () => {
    const fetch = vi.fn(async () =>
      Response.json(
        {
          challengeId: "50000000-0000-4000-8000-000000000001",
          effectDigest: "a".repeat(64),
          contextDigest: "b".repeat(64),
          projectId: "70000000-0000-4000-8000-000000000001",
          threadId: approvalThreadId,
          threadTitle: "Fix login",
          checkoutId: approvalCheckoutId,
          repositoryId: `repo_${"c".repeat(64)}`,
          checkoutHead: { kind: "detached", oid: "d".repeat(40) },
          message: "Allow terminal access?",
          detail: "Authoritative scope",
        },
        { status: 201 },
      ),
    );
    await expect(
      requestCodeOperationApprovalFromServer({
        serverUrl: "http://127.0.0.1:13773/",
        desktopBridgeSecret: "private-secret",
        windowCapability: "window-capability",
        request,
        owner: {},
        dialog: { showMessageBox: vi.fn(async () => ({ response: 1 })) },
        fetch: fetch as never,
      }),
    ).resolves.toBeUndefined();
    expect(fetch).toHaveBeenCalledOnce();

    await expect(
      requestCodeOperationApprovalFromServer({
        serverUrl: "http://127.0.0.1:13773/",
        desktopBridgeSecret: "private-secret",
        windowCapability: "window-capability",
        request,
        owner: {},
        dialog: { showMessageBox: vi.fn(async () => ({ response: 0 })) },
        fetch: vi.fn(async () => new Response("private-secret", { status: 403 })) as never,
      }),
    ).rejects.toThrow("Octant could not approve this Code authority.");
  });

  it("preserves the host-time recovery signal from an unavailable approval response", async () => {
    const failure = await requestCodeOperationApprovalFromServer({
      serverUrl: "http://127.0.0.1:13773/",
      desktopBridgeSecret: "private-secret",
      windowCapability: "window-capability",
      request,
      owner: {},
      dialog: { showMessageBox: vi.fn(async () => ({ response: 0 })) },
      fetch: vi.fn(async () =>
        Response.json(
          {
            category: "unavailable",
            message: "Code operation approval is unavailable while host time recovery is required.",
          },
          { status: 503 },
        ),
      ) as never,
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(CodeOperationApprovalUnavailableError);
    expect(String(failure)).toContain("host time recovery");
  });
});
