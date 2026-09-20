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

  it("tells the pane which Simulators the thread may send input to without a new approval", async () => {
    const snapshot = {
      sequence: 4,
      snapshotAt: "2026-09-19T20:00:03.000Z",
      toolchain: {
        toolchainId: "60000000-0000-4000-8000-000000000007",
        available: true,
        sdks: [],
        discoveredAt: "2026-09-19T20:00:00.000Z",
      },
      simulators: [],
      active: [],
      recentEvidence: [],
    };
    const service = {
      discover: vi.fn(),
      execute: vi.fn(),
      cancel: vi.fn(),
      snapshot: vi.fn(() => snapshot),
      readScreenshotArtifact: vi.fn(),
    };
    const grants = [
      {
        simulatorId: "60000000-0000-4000-8000-00000000000a",
        expiresAt: "2026-09-19T20:15:00.000Z",
      },
    ];
    const inputGrants = vi.fn(() => grants);
    const handler = createAppleToolchainRouteHandler({
      windowAuthorityStore: authorityStore(),
      resolveContext: async () => context,
      service,
      inputGrants,
      now: () => 2,
    });
    const body = { kind: "apple-snapshot-request", authority, ...scope };

    const granted = await handler(request(body));
    expect(granted?.status).toBe(200);
    await expect(granted?.json()).resolves.toMatchObject({
      kind: "apple-runtime-snapshot",
      snapshot: { sequence: 4, inputGrants: grants },
    });
    expect(inputGrants).toHaveBeenCalledWith(scope.threadId);

    // No grant, no field: the pane asks as it always did.
    inputGrants.mockReturnValue([]);
    const ungranted = await (await handler(request(body)))?.json();
    expect(ungranted.snapshot.inputGrants).toBeUndefined();
  });

  it("tells the host what an action came to, so a grant follows what was delivered rather than what was asked", async () => {
    const evidence = {
      actionId: "60000000-0000-4000-8000-000000000008",
      correlationId: "60000000-0000-4000-8000-000000000009",
      authority,
      kind: "tap",
      outcome: "failed",
      simulatorId: "60000000-0000-4000-8000-00000000000a",
      requestedBy: { kind: "local-user", actorId: "60000000-0000-4000-8000-000000000099" },
      diagnostics: [{ severity: "note", message: "tap failed" }],
      artifacts: [],
      cleanup: "not-required",
      durationMs: 5,
      completedAt: "2026-09-19T20:00:01.000Z",
    };
    const service = {
      discover: vi.fn(),
      execute: vi.fn(async () => evidence),
      cancel: vi.fn(),
      snapshot: vi.fn(),
      readScreenshotArtifact: vi.fn(),
    };
    const afterAction = vi.fn();
    const handler = createAppleToolchainRouteHandler({
      windowAuthorityStore: authorityStore(),
      resolveContext: async () => context,
      service,
      afterAction,
      now: () => 2,
      nowIso: () => "2026-09-19T20:00:00.000Z",
    });
    const action = {
      actionId: "60000000-0000-4000-8000-000000000008",
      correlationId: "60000000-0000-4000-8000-000000000009",
      authority,
      ...scope,
      kind: "tap",
      simulatorId: "60000000-0000-4000-8000-00000000000a",
      point: { x: 1, y: 2 },
      requestedBy: { kind: "local-user", actorId: "60000000-0000-4000-8000-000000000099" },
      timeoutMs: 30_000,
      approval: { kind: "not-required" },
    };

    const response = await handler(request({ kind: "apple-action-request", request: action }));

    expect(response?.status).toBe(200);
    expect(afterAction).toHaveBeenCalledTimes(1);
    expect(afterAction).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "tap" }),
      evidence,
      context,
    );
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

  describe("the live Simulator screen", () => {
    const simulatorId = "7E29846E-F920-438E-8AB2-930C1A0F7FB7";
    const streamRequest = (body: unknown, token = capability) =>
      new Request("http://127.0.0.1:13773/api/apple/screen-stream", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-octant-window-capability": token,
          origin: "http://127.0.0.1:5173",
        },
        body: JSON.stringify(body),
      });
    const body = { kind: "apple-screen-stream-request", authority, ...scope, simulatorId };
    const service = {
      discover: vi.fn(),
      execute: vi.fn(),
      cancel: vi.fn(),
      snapshot: vi.fn(),
      readScreenshotArtifact: vi.fn(),
    };

    it("streams the desktop's frames to an authorized window and names the screen's size", async () => {
      const frames = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(Uint8Array.from([0, 0, 0, 2, 0xff, 0xd8]));
          controller.close();
        },
      });
      const watchSimulator = vi.fn(async (_simulatorId: string, _signal: AbortSignal) => ({
        kind: "watching" as const,
        screen: { width: 1206, height: 2622 },
        frames,
      }));
      const handler = createAppleToolchainRouteHandler({
        windowAuthorityStore: authorityStore(),
        service,
        resolveContext: vi.fn(async () => context),
        now: () => 2,
        watchSimulator,
      });

      const response = await handler(streamRequest(body));

      expect(response?.status).toBe(200);
      expect(response?.headers.get("x-octant-simulator-screen")).toBe("1206x2622");
      expect(response?.headers.get("access-control-expose-headers")).toContain(
        "x-octant-simulator-screen",
      );
      expect([...new Uint8Array(await response!.arrayBuffer())]).toEqual([0, 0, 0, 2, 0xff, 0xd8]);
      expect(watchSimulator.mock.calls[0]?.[0]).toBe(simulatorId);
    });

    it("refuses a window with no authority over the thread before the desktop is asked", async () => {
      const watchSimulator = vi.fn();
      const handler = createAppleToolchainRouteHandler({
        windowAuthorityStore: authorityStore(),
        service,
        resolveContext: vi.fn(async () => undefined),
        now: () => 2,
        watchSimulator,
      });

      expect((await handler(streamRequest(body)))?.status).toBe(403);
      expect((await handler(streamRequest(body, "B".repeat(43))))?.status).toBe(401);
      expect(watchSimulator).not.toHaveBeenCalled();
    });

    it("says a host without the desktop app has no live view, and passes on the helper's refusal", async () => {
      const headless = createAppleToolchainRouteHandler({
        windowAuthorityStore: authorityStore(),
        service,
        resolveContext: vi.fn(async () => context),
        now: () => 2,
      });
      const unavailable = await headless(streamRequest(body));
      expect(unavailable?.status).toBe(404);
      expect(JSON.stringify(await unavailable?.json())).toContain("desktop app");

      const refusing = createAppleToolchainRouteHandler({
        windowAuthorityStore: authorityStore(),
        service,
        resolveContext: vi.fn(async () => context),
        now: () => 2,
        watchSimulator: vi.fn(async () => ({
          kind: "refused" as const,
          reason: "not-booted",
          message: "the Simulator is Shutdown",
        })),
      });
      const refused = await refusing(streamRequest(body));
      expect(refused?.status).toBe(409);
      expect(JSON.stringify(await refused?.json())).toContain("the Simulator is Shutdown");
    });
  });
});
