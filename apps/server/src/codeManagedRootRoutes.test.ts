import { randomBytes } from "node:crypto";
import {
  decodeBindingRevisionId,
  decodeCodeRepositoryId,
  decodeCodeThreadId,
  decodeProjectId,
  decodeWindowId,
} from "@octant/contracts";
import { describe, expect, it, vi } from "vitest";
import { createCodeManagedRootRouteHandler } from "./codeManagedRootRoutes";

const secret = randomBytes(32).toString("base64url");
const ids = {
  windowId: decodeWindowId("70000000-0000-4000-8000-000000000001"),
  projectId: decodeProjectId("70000000-0000-4000-8000-000000000002"),
  bindingRevisionId: decodeBindingRevisionId("70000000-0000-4000-8000-000000000003"),
  repositoryId: decodeCodeRepositoryId(`repo_${"a".repeat(64)}`),
  threadId: decodeCodeThreadId("70000000-0000-4000-8000-000000000004"),
  checkoutId: "70000000-0000-4000-8000-000000000005",
  grantId: "70000000-0000-4000-8000-000000000006",
  receiptId: "70000000-0000-4000-8000-000000000007",
} as const;

const creationContext = {
  projectId: ids.projectId,
  bindingRevisionId: ids.bindingRevisionId,
  repositoryId: ids.repositoryId,
  threadId: ids.threadId,
  checkoutId: ids.checkoutId,
  branchIntent: "feature/code-thread",
  refIntent: "refs/heads/development",
} as const;

describe("Code managed-root desktop routes", () => {
  it("plans and creates without accepting or returning canonical paths", async () => {
    const dependencies = routeDependencies();
    const handle = createCodeManagedRootRouteHandler(dependencies);
    const planned = await handle(
      desktopRequest("/api/desktop/code-managed-root-grants", creationContext),
    );
    expect(planned?.status).toBe(201);
    expect(await planned?.json()).toEqual({ grantId: ids.grantId, expiresAt: 61_000 });
    expect(dependencies.resolveRepositoryRoot).toHaveBeenCalledWith(
      ids.projectId,
      ids.bindingRevisionId,
    );
    expect(dependencies.service.planCreation).toHaveBeenCalledWith(
      expect.objectContaining({
        authenticatedWindowId: ids.windowId,
        repositoryRoot: "/private/repository",
      }),
      expect.any(AbortSignal),
    );

    const created = await handle(
      desktopRequest("/api/desktop/code-managed-worktrees", {
        ...creationContext,
        grantId: ids.grantId,
      }),
    );
    expect(created?.status).toBe(201);
    const createdText = await created?.text();
    expect(JSON.parse(createdText ?? "null")).toEqual({
      status: "ready",
      receiptId: ids.receiptId,
      checkoutId: ids.checkoutId,
    });
    expect(createdText).not.toContain("/private");
  });

  it("cleans up only with explicit local confirmation", async () => {
    const dependencies = routeDependencies();
    const handle = createCodeManagedRootRouteHandler(dependencies);
    const missing = await handle(
      desktopRequest(
        "/api/desktop/code-managed-worktrees/cleanup",
        {
          receiptId: ids.receiptId,
          confirmedByLocalUser: false,
        },
        "DELETE",
      ),
    );
    expect(missing?.status).toBe(400);
    expect(dependencies.service.cleanup).not.toHaveBeenCalled();

    const removed = await handle(
      desktopRequest(
        "/api/desktop/code-managed-worktrees/cleanup",
        {
          receiptId: ids.receiptId,
          confirmedByLocalUser: true,
        },
        "DELETE",
      ),
    );
    expect(removed?.status).toBe(200);
    expect(await removed?.json()).toEqual({ status: "removed", receiptId: ids.receiptId });
  });

  it("returns recoverable unavailable when managed-root planning is blocked by host time recovery", async () => {
    const dependencies = routeDependencies();
    dependencies.service.planCreation.mockResolvedValueOnce({ status: "unavailable" } as never);
    const handle = createCodeManagedRootRouteHandler(dependencies);

    const response = await handle(
      desktopRequest("/api/desktop/code-managed-root-grants", creationContext),
    );

    expect(response?.status).toBe(503);
    expect(await response?.json()).toEqual({
      category: "unavailable",
      message: "Managed Code worktree operation is temporarily unavailable.",
    });
  });

  it("passes origin selection through and returns exact source provenance", async () => {
    const dependencies = routeDependencies();
    dependencies.service.create = vi.fn(async () => ({
      status: "ready" as const,
      checkoutId: ids.checkoutId,
      receipt: {
        receiptId: ids.receiptId,
        source: {
          mode: "origin" as const,
          branch: "development",
          remoteName: "origin",
          resolvedHead: "a".repeat(40),
          fetchedAt: "2026-07-24T12:00:00.000Z",
        },
      },
    }));
    const handle = createCodeManagedRootRouteHandler(dependencies);
    const requestBody = {
      ...creationContext,
      startFromOrigin: true,
      remoteName: "origin",
      grantId: ids.grantId,
    };

    await handle(desktopRequest("/api/desktop/code-managed-worktrees", requestBody));

    expect(dependencies.service.create).toHaveBeenCalledWith(
      expect.objectContaining({ startFromOrigin: true, remoteName: "origin" }),
      expect.any(AbortSignal),
    );
    const response = await handle(
      desktopRequest("/api/desktop/code-managed-worktrees", requestBody),
    );
    expect(await response?.json()).toMatchObject({
      status: "ready",
      source: { mode: "origin", remoteName: "origin", resolvedHead: "a".repeat(40) },
    });
  });

  it("fails closed for forged desktop authority, renderer origins, paths, excess fields, and limits", async () => {
    const dependencies = routeDependencies();
    const handle = createCodeManagedRootRouteHandler({ ...dependencies, maxRequestBodySize: 512 });
    for (const [request, status] of [
      [
        desktopRequest("/api/desktop/code-managed-root-grants", creationContext, "POST", "wrong"),
        401,
      ],
      [
        new Request("http://127.0.0.1:13773/api/desktop/code-managed-root-grants", {
          method: "POST",
          headers: { origin: "file://", "x-octant-desktop-secret": secret },
          body: JSON.stringify({ windowId: ids.windowId, ...creationContext }),
        }),
        401,
      ],
      [
        desktopRequest("/api/desktop/code-managed-root-grants", {
          ...creationContext,
          repositoryRoot: "/private/repository",
        }),
        400,
      ],
      [
        desktopRequest("/api/desktop/code-managed-root-grants", {
          ...creationContext,
          padding: "x".repeat(600),
        }),
        413,
      ],
    ] as const) {
      const response = await handle(request);
      expect(response?.status).toBe(status);
      expect(await response?.text()).not.toContain("/private/repository");
    }
    expect(dependencies.service.planCreation).not.toHaveBeenCalled();
  });
});

function routeDependencies() {
  return {
    desktopBridgeSecret: secret,
    resolveRepositoryRoot: vi.fn(async () => "/private/repository"),
    service: {
      planCreation: vi.fn(async () => ({
        status: "planned" as const,
        grant: { grantId: ids.grantId, expiresAt: 61_000 },
      })),
      create: vi.fn(async () => ({
        status: "ready" as const,
        receipt: { receiptId: ids.receiptId },
        checkoutId: ids.checkoutId,
      })),
      cleanup: vi.fn(async () => ({
        status: "removed" as const,
        receipt: { receiptId: ids.receiptId },
      })),
    },
    now: () => 1_000,
  };
}

function desktopRequest(
  path: string,
  body: unknown,
  method = "POST",
  providedSecret = secret,
): Request {
  const payload = JSON.stringify({ windowId: ids.windowId, ...(body as object) });
  return new Request(`http://127.0.0.1:13773${path}`, {
    method,
    headers: { "content-type": "application/json", "x-octant-desktop-secret": providedSecret },
    ...(method === "GET" || method === "HEAD" ? {} : { body: payload }),
  });
}
