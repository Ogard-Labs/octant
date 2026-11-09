import { decodeBrowserCredentialCommand } from "@octant/contracts/browser-credential-use";
import { describe, expect, it, vi } from "vitest";
import {
  BrowserAutomationClientFailure,
  createBrowserAutomationClient,
} from "./browserAutomationClient";

const capability = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const threadId = "10000000-0000-4000-8000-000000000001";
const contextId = "15000000-0000-4000-8000-000000000001";
const authority = {
  hostId: "20000000-0000-4000-8000-000000000001",
  mode: "work",
  projectId: "30000000-0000-4000-8000-000000000001",
  rootId: "40000000-0000-4000-8000-000000000001",
  providerInstanceId: "50000000-0000-4000-8000-000000000001",
  extension: { kind: "core" },
};

describe("BrowserAutomationClient", () => {
  it("sends local session-permission commands and rejects malformed permission scope", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ kind: "browser-session-grants", grants: [] }))
      .mockResolvedValueOnce(
        Response.json({ kind: "browser-session-grants", grants: [{ grantId: "invalid" }] }),
      );
    const client = createBrowserAutomationClient({
      baseUrl: "http://127.0.0.1:13773",
      fetch,
      windowCapability: capability,
    });
    const manage = client.manageSessionGrants;
    if (manage === undefined) throw Error("Missing session-permission route");
    await expect(manage({ kind: "list" })).resolves.toEqual({
      kind: "browser-session-grants",
      grants: [],
    });
    expect(String(fetch.mock.calls[0]?.[0])).toBe(
      "http://127.0.0.1:13773/api/browser/session-grants",
    );
    await expect(manage({ kind: "list" })).rejects.toMatchObject({ category: "protocol" });
  });
  it("sends local upload-manifest commands and rejects malformed permission scope", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ kind: "upload-permissions", permissions: [] }))
      .mockResolvedValueOnce(
        Response.json({ kind: "upload-permissions", permissions: [{ permissionId: "invalid" }] }),
      );
    const client = createBrowserAutomationClient({
      baseUrl: "http://127.0.0.1:13773",
      fetch,
      windowCapability: capability,
    });
    const manage = client.manageUploadPermissions;
    if (manage === undefined) throw Error("Missing session-permission route");
    await expect(manage({ kind: "list" })).resolves.toEqual({
      kind: "upload-permissions",
      permissions: [],
    });
    expect(String(fetch.mock.calls[0]?.[0])).toBe(
      "http://127.0.0.1:13773/api/browser/upload-permissions",
    );
    await expect(manage({ kind: "list" })).rejects.toMatchObject({ category: "protocol" });
  });
  it("strictly decodes task-profile transaction results and preserves host refusals", async () => {
    const selection = { threadId, mode: "code", version: 2, profile: "personal" };
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(Response.json(selection))
      .mockResolvedValueOnce(
        Response.json({ selection, browser: { status: "ready", threadId, evidence: [] } }),
      )
      .mockResolvedValueOnce(
        Response.json({ category: "stale", message: "Original page kept." }, { status: 409 }),
      )
      .mockResolvedValueOnce(Response.json({ ...selection, profile: "named-account" }));
    const client = createBrowserAutomationClient({
      baseUrl: "http://127.0.0.1:13773",
      fetch,
      windowCapability: capability,
    });
    await expect(
      client.readTaskProfile!({ threadId: threadId as never, mode: "code" }),
    ).resolves.toEqual(selection);
    const input = {
      threadId: threadId as never,
      mode: "code" as const,
      expectedVersion: 1 as never,
      profile: "personal" as const,
    };
    await expect(client.selectTaskProfile!(input)).resolves.toMatchObject({ selection });
    await expect(client.selectTaskProfile!(input)).rejects.toMatchObject({
      category: "stale",
      message: "Original page kept.",
    });
    await expect(
      client.readTaskProfile!({ threadId: threadId as never, mode: "code" }),
    ).rejects.toMatchObject({ category: "protocol" });
  });

  it("decodes explicit fill receipts without granting authentication or accepting field values", async () => {
    const planId = "00000000-0000-4000-8000-000000000010";
    const answer = {
      kind: "browser-credential-fill-outcome",
      planId,
      status: "filled",
      effect: "completed",
      message: "Fields filled; sign-in not confirmed.",
    };
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(Response.json(answer))
      .mockResolvedValueOnce(Response.json({ ...answer, password: "fixture-private" }));
    const client = createBrowserAutomationClient({
      baseUrl: "http://127.0.0.1:13773",
      fetch,
      windowCapability: capability,
    });
    const command = decodeBrowserCredentialCommand({
      kind: "confirm-browser-credential-fill",
      contextId,
      threadId,
      mode: "work",
      planId,
    });
    expect(await client.manageCredentialUse?.(command)).toEqual(answer);
    await expect(client.manageCredentialUse?.(command)).rejects.toMatchObject({
      category: "protocol",
    });
  });

  it("sends selected-item permission commands through authenticated transport and rejects malformed answers", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ kind: "browser-credential-grants", grants: [] }))
      .mockResolvedValueOnce(
        Response.json({ kind: "browser-credential-grants", grants: [], password: "fixture" }),
      );
    const client = createBrowserAutomationClient({
      baseUrl: "http://127.0.0.1:13773",
      fetch,
      windowCapability: capability,
    });
    const command = decodeBrowserCredentialCommand({
      kind: "list-browser-credential-grants",
      contextId,
      threadId,
      mode: "work",
    });
    await expect(client.manageCredentialUse?.(command)).resolves.toEqual({
      kind: "browser-credential-grants",
      grants: [],
    });
    expect(fetch).toHaveBeenCalledWith(
      new URL("http://127.0.0.1:13773/api/browser/credential-use"),
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ "x-octant-window-capability": capability }),
      }),
    );
    await expect(client.manageCredentialUse?.(command)).rejects.toBeInstanceOf(
      BrowserAutomationClientFailure,
    );
  });

  it("takes a capture through its own route and reports a refusal as an unauthorized failure", async () => {
    const request = {
      actionId: "70000000-0000-4000-8000-000000000001",
      contextId,
      correlationId: "80000000-0000-4000-8000-000000000001",
      authority,
      kind: "screenshot",
    };
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ status: "running", threadId, evidence: [] }))
      .mockResolvedValueOnce(
        Response.json({ category: "unauthorized", message: "Not here." }, { status: 403 }),
      );
    const client = createBrowserAutomationClient({
      baseUrl: "http://127.0.0.1:13773",
      fetch,
      windowCapability: capability,
    });
    await expect(
      client.takeCapture?.({ threadId: threadId as any, request: request as any }),
    ).resolves.toMatchObject({ status: "running" });
    expect(fetch).toHaveBeenNthCalledWith(
      1,
      new URL("http://127.0.0.1:13773/api/browser/captures/take"),
      expect.objectContaining({ method: "POST" }),
    );
    await expect(client.listCaptures?.({ threadId: threadId as any })).rejects.toMatchObject({
      category: "unauthorized",
    });
  });

  it("lists a thread's captures and reads one as an image through the authenticated routes", async () => {
    const captureId = "16000000-0000-4000-8000-000000000001";
    const capture = {
      captureId,
      threadId,
      origin: "https://example.com",
      url: "https://example.com/",
      hash: "a".repeat(64),
      size: 4,
      mime: "image/png",
      capturedAt: "2026-10-12T09:00:00.000Z",
    };
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ captures: [capture] }))
      .mockResolvedValueOnce(Response.json({ captureId, dataUrl: "data:image/png;base64,AAAA" }));
    const client = createBrowserAutomationClient({
      baseUrl: "http://127.0.0.1:13773",
      fetch,
      windowCapability: capability,
    });
    await expect(client.listCaptures?.({ threadId: threadId as any })).resolves.toEqual({
      captures: [capture],
    });
    await expect(
      client.readCapture?.({ threadId: threadId as any, captureId: captureId as any }),
    ).resolves.toEqual({ captureId, dataUrl: "data:image/png;base64,AAAA" });
    expect(fetch).toHaveBeenNthCalledWith(
      1,
      new URL("http://127.0.0.1:13773/api/browser/captures"),
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ "x-octant-window-capability": capability }),
      }),
    );
    expect(fetch).toHaveBeenNthCalledWith(
      2,
      new URL("http://127.0.0.1:13773/api/browser/captures/image"),
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("reads the thread's recorded steps through the steps route", async () => {
    const step = {
      stepId: "b0000000-0000-4000-8000-000000000020",
      threadId,
      operation: "click",
      recordedAt: "2026-10-12T09:00:00.000Z",
    };
    const fetch = vi.fn(async () => Response.json({ steps: [step] }));
    const client = createBrowserAutomationClient({
      baseUrl: "http://127.0.0.1:13773",
      fetch,
      windowCapability: capability,
    });
    await expect(client.listSteps?.({ threadId: threadId as any })).resolves.toEqual({
      steps: [step],
    });
    expect(fetch).toHaveBeenCalledWith(
      new URL("http://127.0.0.1:13773/api/browser/steps"),
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("resolves thread authority through the authenticated server route", async () => {
    const fetch = vi.fn(async () => Response.json({ threadId, authority }));
    const client = createBrowserAutomationClient({
      baseUrl: "http://127.0.0.1:13773",
      fetch,
      windowCapability: capability,
    });
    await expect(client.resolve({ threadId: threadId as any, mode: "work" })).resolves.toEqual({
      threadId,
      authority,
    });
    expect(fetch).toHaveBeenCalledWith(
      new URL("http://127.0.0.1:13773/api/browser/scope"),
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ "x-octant-window-capability": capability }),
      }),
    );
  });

  it("invokes the browser fetch function without rebinding its receiver", async () => {
    const fetch = vi.fn(function (this: unknown) {
      expect(this).toBeUndefined();
      return Promise.resolve(Response.json({ threadId, authority }));
    });
    const client = createBrowserAutomationClient({
      baseUrl: "http://127.0.0.1:13773",
      fetch,
      windowCapability: capability,
    });
    await expect(client.resolve({ threadId: threadId as any, mode: "work" })).resolves.toEqual({
      threadId,
      authority,
    });
  });

  it("maps typed server failures", async () => {
    const client = createBrowserAutomationClient({
      baseUrl: "http://127.0.0.1:13773",
      fetch: vi.fn(async () =>
        Response.json({ category: "policy-denied", message: "Origin denied." }, { status: 403 }),
      ),
      windowCapability: capability,
    });
    await expect(client.resolve({ threadId: threadId as any, mode: "work" })).rejects.toEqual(
      expect.objectContaining<Partial<BrowserAutomationClientFailure>>({
        category: "policy-denied",
        message: "Origin denied.",
      }),
    );
  });

  it("sends the owning thread with lifecycle commands", async () => {
    let sentBody: unknown;
    const fetch = vi.fn(
      async (_input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
        sentBody = JSON.parse(String(init?.body));
        return Response.json({ status: "ready", threadId, evidence: [] });
      },
    );
    const client = createBrowserAutomationClient({
      baseUrl: "http://127.0.0.1:13773",
      fetch,
      windowCapability: capability,
    });
    await client.inspect({ contextId: contextId as any, threadId: threadId as any });
    expect(sentBody).toEqual({ contextId, threadId });
  });

  it("reattaches and releases by authoritative thread scope", async () => {
    const requests: Array<{ readonly path: string; readonly body: unknown }> = [];
    const client = createBrowserAutomationClient({
      baseUrl: "http://127.0.0.1:13773",
      fetch: vi.fn(async (input, init) => {
        requests.push({
          path: new URL(String(input)).pathname,
          body: JSON.parse(String(init?.body)),
        });
        return Response.json({ status: "ready", threadId, evidence: [] });
      }),
      windowCapability: capability,
    });

    await client.inspectThread({ threadId: threadId as any });
    await client.inspectThread({ threadId: threadId as any, freshPicture: false });
    await client.releaseThread({ threadId: threadId as any });

    expect(requests).toEqual([
      { path: "/api/browser/contexts/current", body: { threadId } },
      { path: "/api/browser/contexts/current", body: { threadId, freshPicture: false } },
      { path: "/api/browser/contexts/release", body: { threadId } },
    ]);
  });

  it("takes the page over and hands it back by thread, and reads what the host holds", async () => {
    const requests: Array<{ readonly path: string; readonly body: unknown }> = [];
    const client = createBrowserAutomationClient({
      baseUrl: "http://127.0.0.1:13773",
      fetch: vi.fn(async (input, init) => {
        const path = new URL(String(input)).pathname;
        requests.push({ path, body: JSON.parse(String(init?.body)) });
        return Response.json({
          status: "ready",
          threadId,
          evidence: [],
          ...(path.endsWith("/take-over") ? { waitingForPerson: "take-over" } : {}),
        });
      }),
      windowCapability: capability,
    });

    const taken = await client.takeOver?.({ threadId: threadId as any });
    const handed = await client.handBack?.({ threadId: threadId as any });

    expect(taken?.waitingForPerson).toBe("take-over");
    expect(handed?.waitingForPerson).toBeUndefined();
    expect(requests).toEqual([
      { path: "/api/browser/contexts/take-over", body: { threadId } },
      { path: "/api/browser/contexts/hand-back", body: { threadId } },
    ]);
  });

  it("maps request aborts to interrupted", async () => {
    const controller = new AbortController();
    const client = createBrowserAutomationClient({
      baseUrl: "http://127.0.0.1:13773",
      fetch: vi.fn(async () => {
        controller.abort();
        throw new DOMException("aborted", "AbortError");
      }),
      windowCapability: capability,
    });
    await expect(
      client.resolve({ threadId: threadId as any, mode: "work" }, controller.signal),
    ).rejects.toMatchObject({ category: "interrupted" });
  });

  it("lists and decides browser approvals through the authenticated route", async () => {
    const requests: Array<{ readonly path: string; readonly body: unknown }> = [];
    const client = createBrowserAutomationClient({
      baseUrl: "http://127.0.0.1:13773",
      fetch: vi.fn(async (input, init) => {
        requests.push({
          path: new URL(String(input)).pathname,
          body: JSON.parse(String(init?.body)),
        });
        return Response.json(
          new URL(String(input)).pathname.endsWith("approvals") &&
            (JSON.parse(String(init?.body)) as { kind?: string }).kind === "list"
            ? [
                {
                  approvalId: "60000000-0000-4000-8000-000000000001",
                  threadId,
                  mode: "chat",
                  origin: "https://example.com",
                  requestedAt: "2026-09-09T10:00:00.000Z",
                },
              ]
            : { accepted: true },
        );
      }),
      windowCapability: capability,
    });
    await expect(client.listApprovals?.()).resolves.toHaveLength(1);
    await expect(
      client.decideApproval?.({
        approvalId: "60000000-0000-4000-8000-000000000001" as never,
        decision: "approved",
      }),
    ).resolves.toBe(true);
    expect(requests).toEqual([
      { path: "/api/browser/approvals", body: { kind: "list" } },
      {
        path: "/api/browser/approvals",
        body: {
          kind: "decide",
          approvalId: "60000000-0000-4000-8000-000000000001",
          decision: "approved",
        },
      },
    ]);
  });

  it("answers false, not a failure, when the host no longer takes the decision", async () => {
    // The host answers 409 with `{ accepted: false }` when the request expired
    // or another window answered it first; that is an expected refusal.
    const client = createBrowserAutomationClient({
      baseUrl: "http://127.0.0.1:13773",
      fetch: vi.fn(async () => Response.json({ accepted: false }, { status: 409 })),
      windowCapability: capability,
    });
    await expect(
      client.decideApproval?.({
        approvalId: "60000000-0000-4000-8000-000000000001" as never,
        decision: "denied",
      }),
    ).resolves.toBe(false);
  });
});

it("sends a strict download manifest command through authenticated transport and decodes the host result", async () => {
  const request = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
    expect(new Headers(init?.headers).get("x-octant-window-capability")).toBe(capability);
    expect(JSON.parse(String(init?.body))).toEqual({ kind: "list" });
    return Response.json({ kind: "download-permissions", permissions: [] });
  });
  const client = createBrowserAutomationClient({
    baseUrl: "http://127.0.0.1:13773",
    windowCapability: capability,
    fetch: request,
  });
  expect(await client.manageDownloadPermissions?.({ kind: "list" })).toEqual({
    kind: "download-permissions",
    permissions: [],
  });
  expect(String(request.mock.calls[0]?.[0])).toBe(
    "http://127.0.0.1:13773/api/browser/download-permissions",
  );
});
