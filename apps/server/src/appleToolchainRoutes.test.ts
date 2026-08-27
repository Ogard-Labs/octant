import type { AppleExecutionContext } from "./apple/appleToolchainService";
import { WindowAuthorityStore } from "./windowAuthorityStore";
import { beforeAll, describe, expect, it, vi } from "vitest";

let createAppleToolchainRouteHandler: (
  options: Record<string, unknown>,
) => (request: Request) => Promise<Response | undefined>;

beforeAll(async () => {
  const path = "./appleToolchainRoutes";
  const loaded = await import(path).catch(() => undefined);
  expect(loaded).toBeDefined();
  expect(loaded?.createAppleToolchainRouteHandler).toBeTypeOf("function");
  createAppleToolchainRouteHandler = loaded!.createAppleToolchainRouteHandler;
});

const capability = "A".repeat(43);
const windowId = "60000000-0000-4000-8000-000000000001" as never;
const authority = {
  hostId: "60000000-0000-4000-8000-000000000002",
  mode: "code",
  projectId: "60000000-0000-4000-8000-000000000003",
  providerInstanceId: "60000000-0000-4000-8000-000000000004",
  extension: { kind: "core" },
} as const;
const scope = {
  threadId: "60000000-0000-4000-8000-000000000005",
  checkoutId: "60000000-0000-4000-8000-000000000006",
} as const;
const context: AppleExecutionContext = {
  authority: authority as never,
  threadId: scope.threadId as never,
  checkoutId: scope.checkoutId as never,
  checkoutRoot: "/private/project",
  artifactRoot: "/private/artifacts",
  sourceRevision: "a".repeat(40),
  executionPolicy: "full-access",
  approvalValid: true,
};

function authorityStore() {
  const store = new WindowAuthorityStore();
  store.register({ windowId, capability, now: 1 });
  return store;
}

function request(body: unknown, token = capability) {
  return new Request("http://127.0.0.1:13773/api/apple/toolchain", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-octant-window-capability": token,
      origin: "http://127.0.0.1:5173",
    },
    body: JSON.stringify(body),
  });
}

describe("Apple toolchain routes", () => {
  it("authenticates the window and returns a normalized discovery snapshot", async () => {
    const discovery = {
      toolchain: {
        toolchainId: "60000000-0000-4000-8000-000000000007",
        available: true,
        sdks: [],
        discoveredAt: "2026-07-27T20:00:00.000Z",
      },
      workspace: {
        actionId: "60000000-0000-4000-8000-000000000008",
        correlationId: "60000000-0000-4000-8000-000000000009",
        authority,
        projectPath: "Fixture.xcodeproj",
        projectKind: "xcode-project",
        schemes: ["Fixture"],
        configurations: ["Debug"],
        targets: ["Fixture"],
        sourceRevision: "a".repeat(40),
        discoveredAt: "2026-07-27T20:00:00.000Z",
      },
      simulators: [],
    } as const;
    const service = {
      discover: vi.fn(async () => ({ kind: "discovered", ...discovery })),
      execute: vi.fn(),
      cancel: vi.fn(),
      snapshot: vi.fn(),
      readScreenshotArtifact: vi.fn(),
    };
    const resolveContext = vi.fn(async () => context);
    const handler = createAppleToolchainRouteHandler({
      windowAuthorityStore: authorityStore(),
      resolveContext,
      service,
      now: () => 2,
    });
    const response = await handler(
      request({
        kind: "apple-discovery-request",
        request: {
          actionId: discovery.workspace.actionId,
          correlationId: discovery.workspace.correlationId,
          authority,
          ...scope,
          projectPath: "Fixture.xcodeproj",
        },
      }),
    );
    expect(response?.status).toBe(200);
    await expect(response?.json()).resolves.toMatchObject({
      kind: "apple-discovery-snapshot",
      snapshot: { workspace: { schemes: ["Fixture"] } },
    });
    expect(resolveContext).toHaveBeenCalledWith(
      windowId,
      expect.objectContaining(scope),
      expect.objectContaining({ kind: "apple-discovery-request" }),
    );
    expect(service.discover).toHaveBeenCalledWith(expect.any(Object), context);
  });

  it("fails closed before service access for invalid window authority", async () => {
    const service = {
      discover: vi.fn(),
      execute: vi.fn(),
      cancel: vi.fn(),
      snapshot: vi.fn(),
      readScreenshotArtifact: vi.fn(),
    };
    const handler = createAppleToolchainRouteHandler({
      windowAuthorityStore: authorityStore(),
      resolveContext: vi.fn(),
      service,
      now: () => 2,
    });
    const response = await handler(
      request({ kind: "apple-snapshot-request", authority, ...scope }, "invalid"),
    );
    expect(response?.status).toBe(401);
    expect(service.snapshot).not.toHaveBeenCalled();
  });

  it("does not leak a denied root or unrelated log detail", async () => {
    const privatePath = "/private/other-project/secret";
    const service = {
      discover: vi.fn(),
      execute: vi.fn(),
      cancel: vi.fn(),
      snapshot: vi.fn(),
      readScreenshotArtifact: vi.fn(),
    };
    const handler = createAppleToolchainRouteHandler({
      windowAuthorityStore: authorityStore(),
      resolveContext: vi.fn(async () => undefined),
      service,
      now: () => 2,
    });
    const response = await handler(
      request({ kind: "apple-snapshot-request", authority, ...scope, privatePath }),
    );
    expect(response?.status).toBe(400);
    expect(await response?.text()).not.toContain(privatePath);
    expect(service.snapshot).not.toHaveBeenCalled();
  });

  it("refuses screenshot bytes outside the window's authorized thread scope", async () => {
    const service = {
      discover: vi.fn(),
      execute: vi.fn(),
      cancel: vi.fn(),
      snapshot: vi.fn(),
      readScreenshotArtifact: vi.fn(),
    };
    const resolveContext = vi.fn(async () => undefined);
    const handler = createAppleToolchainRouteHandler({
      windowAuthorityStore: authorityStore(),
      resolveContext,
      service,
      now: () => 2,
    });
    const response = await handler(
      new Request("http://127.0.0.1:13773/api/apple/artifacts", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-octant-window-capability": capability,
          origin: "http://127.0.0.1:5173",
        },
        body: JSON.stringify({
          kind: "apple-artifact-request",
          authority,
          ...scope,
          reference: "apple-screenshot-other-thread",
        }),
      }),
    );
    expect(response?.status).toBe(403);
    expect(resolveContext).toHaveBeenCalledWith(
      windowId,
      expect.objectContaining(scope),
      expect.any(Object),
    );
    expect(service.readScreenshotArtifact).not.toHaveBeenCalled();
  });

  it("returns host-held screenshot bytes without putting them in the JSON envelope", async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    const service = {
      discover: vi.fn(),
      execute: vi.fn(),
      cancel: vi.fn(),
      snapshot: vi.fn(),
      readScreenshotArtifact: vi.fn(async () => ({ kind: "found" as const, bytes: png })),
    };
    const handler = createAppleToolchainRouteHandler({
      windowAuthorityStore: authorityStore(),
      resolveContext: vi.fn(async () => context),
      service,
      now: () => 2,
    });
    const response = await handler(
      new Request("http://127.0.0.1:13773/api/apple/artifacts", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-octant-window-capability": capability,
          origin: "http://127.0.0.1:5173",
        },
        body: JSON.stringify({
          kind: "apple-artifact-request",
          authority,
          ...scope,
          reference: "apple-screenshot-1",
        }),
      }),
    );
    expect(response?.status).toBe(200);
    expect(response?.headers.get("content-type")).toBe("image/png");
    expect(new Uint8Array(await response!.arrayBuffer())).toEqual(png);
    expect(service.readScreenshotArtifact).toHaveBeenCalledWith("apple-screenshot-1", context);
  });
});
